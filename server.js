'use strict';

/* =====================================================================
   Danychat server — zero dependencies (Node 18+).
   - Accounts: scrypt-hashed passwords, random session tokens in HttpOnly cookies
   - Real friends, chat, video posts, likes and friend leaderboards
   - Realtime updates over Server-Sent Events
   - The only simulated "person" is DANY AI, a scripted bot (see botReply)
   Data lives in ./data (db.json + videos/). Set DATA_DIR to move it.
   ===================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = +process.env.PORT || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_VIDEO = 60 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const BOT = 'dany_ai';
// Moderators are decided here on the server, by username (override with MODS=name1,name2). Set at signup time by whoever owns the account,
// so make sure these accounts exist before opening the app to other people.
const MODS = new Set((process.env.MODS || 'grantclark').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const isMod = u => MODS.has(u);
const MOD_COINS = 100;

fs.mkdirSync(VIDEO_DIR, { recursive: true });

/* ---------- tiny database (JSON file, atomic writes) ---------- */
const emptyDb = () => ({ users: {}, friends: {}, requests: {}, follows: {}, convs: {}, streaks: {}, posts: [], reposts: [], scores: {}, sessions: {} });
let db = emptyDb();
try {
  db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Refusing to start: could not read ${DB_FILE} (${e.message}). Fix or move it aside.`); process.exit(1); }
}
// Older databases predate coins, pets, dislikes and audio tracks — fill those in.
for (const u of Object.values(db.users)) { if (u.coins == null) u.coins = 100; u.pets ||= []; u.emojis ||= []; u.tags ||= []; u.lastDaily ||= 0; }
for (const p of db.posts) { p.dislikes ||= []; p.audio ||= null; }
let saveTimer = null;
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 150); }
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => new HttpError(400, m);
const rid = () => crypto.randomBytes(8).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const pick = a => a[Math.floor(Math.random() * a.length)];
const edgeKey = (a, b) => [a, b].sort().join('|');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, tooBig = false;
    // Past the limit we stop buffering and answer 413; the error handler closes the connection once the reply is sent.
    req.on('data', c => { if (tooBig) return; n += c.length; if (n > limit) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'Request too large')); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter(t => now - t < windowMs);
  const over = a.length >= max;
  if (!over) a.push(now);
  hits.set(key, a);
  return over;
}
setInterval(() => { for (const [k, v] of hits) if (!v.some(t => Date.now() - t < 3600e3)) hits.delete(k); }, 3600e3).unref();

const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
const isHttps = req => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

/* ---------- accounts & sessions ---------- */
const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const reserved = u => u.replace(/_/g, '').startsWith('danyai') || ['admin', 'support', 'system', 'danychat'].includes(u);

async function makeHash(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: (await scrypt(pw, salt, 64)).toString('hex') };
}
const DUMMY = { salt: crypto.randomBytes(16).toString('hex'), hash: crypto.randomBytes(64).toString('hex') };
async function checkPw(user, pw) {
  const u = user || DUMMY;                                     // burn the same time for unknown users
  const h = await scrypt(pw, Buffer.from(u.salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')) && !!user;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getSession(req) {
  const tok = parseCookies(req).dc_session;
  const s = tok && db.sessions[sha(tok)];
  return s && s.exp > Date.now() && db.users[s.u] ? s.u : null;
}
function startSession(req, res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { u: username, exp: Date.now() + SESSION_MS };
  save();
  return `dc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
}
function purgeSessions() { for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k]; save(); }
purgeSessions(); setInterval(purgeSessions, 3600e3).unref();

/* ---------- avatars (indexes into palettes that live in the client) ---------- */
const AV_KEYS = ['skin', 'hair', 'hairColor', 'eyes', 'brows', 'mouth', 'beard', 'extras', 'glasses', 'hat', 'hatColor', 'outfit', 'outfitColor', 'bg'];
const DEFAULT_AVATAR = { pet: 0, skin: 1, hair: 1, hairColor: 1, eyes: 0, brows: 1, mouth: 0, beard: 0, extras: 0, glasses: 0, hat: 0, hatColor: 0, outfit: 0, outfitColor: 0, bg: 0 };
// Keep this order in sync with PET_IDS in avatar.js — an avatar's `pet` value is (index + 1); 0 means no pet.
const PETS = [
  { id: 'duck',   name: 'Ducky',    price: 30 },
  { id: 'dog',    name: 'Buddy',    price: 50 },
  { id: 'cat',    name: 'Whiskers', price: 50 },
  { id: 'bunny',  name: 'Clover',   price: 60 },
  { id: 'fox',    name: 'Rusty',    price: 90 },
  { id: 'panda',  name: 'Bamboo',   price: 120 },
  { id: 'ghost',  name: 'Boo',      price: 150 },
  { id: 'dragon', name: 'Ember',    price: 250 },
  { id: 'key',    name: 'Garage Key', price: 75 },
  { id: 'frog',     name: 'Ribbit',   price: 35 },
  { id: 'penguin',  name: 'Waddles',  price: 70 },
  { id: 'owl',      name: 'Hoot',     price: 85 },
  { id: 'hedgehog', name: 'Spike',    price: 65 },
  { id: 'octopus',  name: 'Inky',     price: 110 },
  { id: 'unicorn',  name: 'Sparkle',  price: 200 },
  { id: 'alien',    name: 'Zorp',     price: 140 },
  { id: 'robot',    name: 'Bolt',     price: 160 },
];
// Premium emojis: bought once, then sent from any chat as big animated "stickers". The server checks ownership on every send.
const EMOJIS = [
  { id: 'pumpkin', emoji: '🎃', name: 'Pumpkin', price: 15 }, { id: 'pizza',  emoji: '🍕', name: 'Pizza',   price: 15 },
  { id: 'donut',   emoji: '🍩', name: 'Donut',   price: 15 }, { id: 'ghost',  emoji: '👻', name: 'Ghost',   price: 15 },
  { id: 'party',   emoji: '🥳', name: 'Party',   price: 20 }, { id: 'guitar', emoji: '🎸', name: 'Guitar',  price: 20 },
  { id: 'target',  emoji: '🎯', name: 'Bullseye', price: 20 }, { id: 'unicorn', emoji: '🦄', name: 'Unicorn', price: 20 },
  { id: 'rainbow', emoji: '🌈', name: 'Rainbow', price: 25 }, { id: 'robot',  emoji: '🤖', name: 'Robot',   price: 25 },
  { id: 'eye',     emoji: '🧿', name: 'Evil eye', price: 25 }, { id: 'rocket', emoji: '🚀', name: 'Rocket',  price: 30 },
  { id: 'star',    emoji: '🌟', name: 'Glow star', price: 30 }, { id: 'ufo',    emoji: '🛸', name: 'UFO',     price: 35 },
  { id: 'dragon',  emoji: '🐉', name: 'Dragon',  price: 40 }, { id: 'trophy', emoji: '🏆', name: 'Trophy',  price: 45 },
  { id: 'crown',   emoji: '👑', name: 'Crown',   price: 50 }, { id: 'diamond', emoji: '💎', name: 'Diamond', price: 60 },
];
// Name tags: cosmetic badges next to your name, like the 🔨 MOD badge but with no powers. Colours are fixed here (never user input),
// and none of them may say "MOD" or use the moderator gold.
const TAGS = [
  { id: 'cool',   label: '😎 COOL',      price: 50,  bg: '#3b82f6', fg: '#ffffff' },
  { id: 'hot',    label: '🔥 HOT',       price: 60,  bg: '#ff6b35', fg: '#ffffff' },
  { id: 'gamer',  label: '🎮 GAMER',     price: 60,  bg: '#22c55e', fg: '#04220f' },
  { id: 'artist', label: '🎨 ARTIST',    price: 70,  bg: '#14b8a6', fg: '#02201d' },
  { id: 'vip',    label: '⭐ VIP',       price: 80,  bg: '#8b5cf6', fg: '#ffffff' },
  { id: 'lucky',  label: '🍀 LUCKY',     price: 90,  bg: '#84cc16', fg: '#1a2e05' },
  { id: 'night',  label: '🌙 NIGHT OWL', price: 90,  bg: '#4338ca', fg: '#ffffff' },
  { id: 'magic',  label: '🦄 MAGIC',     price: 120, bg: '#d946ef', fg: '#ffffff' },
  { id: 'royal',  label: '👑 ROYAL',     price: 150, bg: '#ec4899', fg: '#ffffff' },
  { id: 'rich',   label: '💎 RICH',      price: 250, bg: '#06b6d4', fg: '#00232b' },
];
const tagObj = id => { const t = TAGS.find(x => x.id === id); return t ? { label: t.label, bg: t.bg, fg: t.fg } : null; };
function sanitizeAvatar(a, owned = []) {
  if (!a || typeof a !== 'object') return null;
  const o = {};
  for (const k of AV_KEYS) { if (!Number.isInteger(a[k]) || a[k] < 0 || a[k] > 30) return null; o[k] = a[k]; }
  const pet = a.pet === undefined ? 0 : a.pet;
  if (!Number.isInteger(pet) || pet < 0 || pet > PETS.length) return null;
  if (pet && !owned.includes(PETS[pet - 1].id)) return null;            // you can only wear pets you bought
  o.pet = pet;
  return o;
}

const userObj = u => u === BOT
  ? { username: BOT, name: 'DANY AI', bot: true, avatar: null }
  : { username: u, name: u, avatar: db.users[u]?.avatar || DEFAULT_AVATAR, ...(isMod(u) ? { mod: true } : {}), ...(tagObj(db.users[u]?.tag) ? { tag: tagObj(db.users[u].tag) } : {}) };

/* ---------- realtime (SSE) ---------- */
const streams = new Map();   // username -> Set<res>
function notify(users, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const u of new Set(users)) for (const res of streams.get(u) || []) res.write(data);
}

/* ---------- friends ---------- */
const areFriends = (a, b) => a !== b && (a === BOT || b === BOT ? !!db.users[a === BOT ? b : a] : !!db.friends[edgeKey(a, b)]);
function friendsOf(u) {
  const out = [BOT];
  for (const k of Object.keys(db.friends)) { const [a, b] = k.split('|'); if (a === u) out.push(b); else if (b === u) out.push(a); }
  return out;
}
const incomingOf = u => Object.keys(db.requests).map(k => k.split('>')).filter(([, to]) => to === u).map(([from]) => from);
const outgoingOf = u => Object.keys(db.requests).map(k => k.split('>')).filter(([from]) => from === u).map(([, to]) => to);
function assertFriend(me, other) {
  if (!areFriends(me, other)) throw new HttpError(403, 'You can only do that with friends');
}
// New friendships pay Dan Coins: +15 each, for up to 5 new friends a day, and re-adding the same person never pays twice.
const FRIEND_REWARD = 15, FRIEND_REWARDS_PER_DAY = 5;
function friendReward(u, other) {
  const usr = db.users[u];
  if (!usr || other === BOT) return 0;
  usr.rewardedFriends ||= [];
  if (usr.rewardedFriends.includes(other)) return 0;
  if (usr.friendRewardDay !== dayKey()) { usr.friendRewardDay = dayKey(); usr.friendRewardsToday = 0; }
  if (usr.friendRewardsToday >= FRIEND_REWARDS_PER_DAY) return 0;
  usr.friendRewardsToday++; usr.rewardedFriends.push(other);
  return earn(u, FRIEND_REWARD);
}
function makeFriends(a, b) {
  delete db.requests[`${a}>${b}`]; delete db.requests[`${b}>${a}`];
  const fresh = !db.friends[edgeKey(a, b)];
  db.friends[edgeKey(a, b)] = Date.now();
  save(); notify([a, b], { type: 'friends' });
  if (!fresh) return;
  for (const [u, o] of [[a, b], [b, a]]) {
    const amount = friendReward(u, o);
    if (amount) notify([u], { type: 'coins', amount, coins: db.users[u].coins, reason: 'friend' });
  }
}

/* ---------- follows, mutual friends, recommendations, coins ---------- */
const followersOf = u => Object.keys(db.follows).map(k => k.split('>')).filter(([, t]) => t === u).map(([f]) => f);
const followingOf = u => Object.keys(db.follows).map(k => k.split('>')).filter(([f]) => f === u).map(([, t]) => t);
const realFriends = u => friendsOf(u).filter(x => x !== BOT);           // everyone is friends with DANY AI, so it never counts as "mutual"
function mutualWith(a, b) {
  if (a === b || a === BOT || b === BOT) return [];
  const fb = new Set(realFriends(b));
  return realFriends(a).filter(x => fb.has(x));
}
const decorate = (u, me) => ({ ...userObj(u), mutual: mutualWith(me, u).length });
function adjacency() {
  const m = new Map();
  const link = (a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const k of Object.keys(db.friends)) { const [a, b] = k.split('|'); link(a, b); link(b, a); }
  return m;
}
const earn = (u, amount) => { db.users[u].coins += amount; return amount; };
const dayKey = () => new Date().toISOString().slice(0, 10);
function postReward(u) {                                                 // +10 coins for each of your first 3 posts per day
  const usr = db.users[u];
  if (usr.rewardDay !== dayKey()) { usr.rewardDay = dayKey(); usr.rewardPosts = 0; }
  if (usr.rewardPosts >= 3) return 0;
  usr.rewardPosts++;
  return earn(u, 10);
}

/* ---------- streaks ----------
   Like a Snap streak: it grows by one for every calendar day on which BOTH friends have messaged each other, and it ends if a whole
   day passes without that. Days are the server's local calendar days. (CLOCK_SKEW_MS shifts "now" — only used by the tests.) */
const SKEW = Number(process.env.CLOCK_SKEW_MS) || 0;
const localDay = (t = Date.now() + SKEW) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayNum = day => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
function recordStreak(from, to) {
  if (from === BOT || to === BOT) return;
  const today = localDay(), st = (db.streaks[edgeKey(from, to)] ||= { count: 0, last: null, days: {} });
  st.days[from] = today;
  if (st.days[to] === today && st.last !== today) {                       // both have now written today
    st.count = st.last && dayNum(today) - dayNum(st.last) === 1 ? st.count + 1 : 1;
    st.last = today;
  }
}
function streakOf(me, other) {
  const st = db.streaks[edgeKey(me, other)];
  if (!st) return { count: 0, atRisk: false, you: false, them: false };
  const today = localDay(), gap = st.last ? dayNum(today) - dayNum(st.last) : Infinity, alive = gap <= 1;
  return { count: alive ? st.count : 0, atRisk: alive && gap === 1, you: st.days[me] === today, them: st.days[other] === today };
}

/* ---------- messages ---------- */
const convKey = (a, b) => edgeKey(a, b);
function addMessage(from, to, text, vanish = false, sticker = null) {
  const list = (db.convs[convKey(from, to)] ||= []);
  const msg = { id: rid(), from, to, text, t: Date.now(), readAt: to === BOT ? Date.now() : null };
  if (vanish) msg.vanish = true;
  if (sticker) msg.sticker = sticker;
  list.push(msg);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  save(); notify([from, to], { type: 'message', msg });
  return msg;
}

/* ---------- games & scores ---------- */
const GAMES = {
  ttt:      { name: 'Tic-Tac-Toe',         mode: 'sum', unit: 'wins' },
  c4:       { name: 'Connect Four',        mode: 'sum', unit: 'wins' },
  rps:      { name: 'Rock Paper Scissors', mode: 'sum', unit: 'wins' },
  memory:   { name: 'Memory Match',        mode: 'min', unit: 'moves' },
  snake:    { name: 'Snake',               mode: 'max', unit: 'pts' },
  g2048:    { name: '2048',                mode: 'max', unit: 'pts' },
  mines:    { name: 'Minesweeper',         mode: 'min', unit: 's' },
  flappy:   { name: 'Flappy Jump',         mode: 'max', unit: 'pts' },
  reaction: { name: 'Reaction Time',       mode: 'min', unit: 'ms' },
  whack:    { name: 'Whack-a-Mole',        mode: 'max', unit: 'pts' },
  simon:    { name: 'Simon Says',          mode: 'max', unit: 'pts' },
  breakout: { name: 'Breakout',            mode: 'max', unit: 'pts' },
};
const better = (mode, a, b) => (mode === 'min' ? a < b : a > b);
const myScores = u => Object.fromEntries(Object.keys(GAMES).filter(g => db.scores[g]?.[u] != null).map(g => [g, db.scores[g][u]]));

/* ---------- DANY AI: a small scripted bot (the one simulated "person") ---------- */
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'I would tell you a UDP joke, but you might not get it.',
  'There are 10 kinds of people: those who understand binary and those who don’t.',
  'Why did the developer go broke? He used up all his cache. 💸',
  'A SQL query walks into a bar, walks up to two tables and asks: “Can I join you?”',
  'How many programmers does it take to change a light bulb? None — that’s a hardware problem.',
];
const EIGHT = ['Yes, definitely.', 'It is certain.', 'Ask again later.', 'Very doubtful.', 'Signs point to yes.', 'My reply is no.', 'Without a doubt.', 'Outlook not so good.', 'Cannot predict now.'];
const FALLBACK = ['Hmm, I’m a simple bot — try “help” to see what I can do. 🤖', 'Not sure I follow! Ask me for a joke, a game idea, or your scores.', 'I only know a few tricks. Type “help” for the list!'];

function botReply(user, raw) {
  const t = raw.toLowerCase();
  if (/\bhelp\b|what can you do|commands/.test(t)) return 'I can: tell a joke 😄, flip a coin 🪙, roll a die 🎲, suggest a game 🎮, show your scores 🏆, count your friends 👥, or answer yes/no questions with the magic 8-ball 🎱.';
  if (/who are you|your name|are you (real|a bot|human)|what are you/.test(t)) return 'I’m DANY AI — Danychat’s built-in bot. I’m a simple scripted bot, not a person, so I only know a handful of tricks. Type “help” to see them.';
  if (/^(hi|hey|hello|yo|sup|hiya)\b/.test(t)) return pick([`Hey ${user}! 👋 Ask me for a joke or a game idea.`, `Hello ${user}! Type “help” to see what I can do.`]);
  if (/joke|funny|laugh/.test(t)) return pick(JOKES);
  if (/coin|flip/.test(t)) return `🪙 ${Math.random() < .5 ? 'Heads!' : 'Tails!'}`;
  if (/\bdice\b|\broll\b|\bdie\b/.test(t)) return `🎲 You rolled a ${1 + Math.floor(Math.random() * 6)}.`;
  if (/score|leaderboard|best|record/.test(t)) {
    const s = myScores(user), lines = Object.entries(s).map(([g, v]) => `${GAMES[g].name}: ${v} ${GAMES[g].unit}`);
    return lines.length ? `🏆 Your bests —\n${lines.join('\n')}` : 'You haven’t set any scores yet. Try a game in the Games tab! 🎮';
  }
  if (/game|play|bored/.test(t)) {
    const unplayed = Object.keys(GAMES).filter(g => db.scores[g]?.[user] == null);
    return `🎮 How about ${GAMES[pick(unplayed.length ? unplayed : Object.keys(GAMES))].name}? You can also beat me at Tic-Tac-Toe, Connect Four or Rock Paper Scissors.`;
  }
  if (/friend/.test(t)) { const n = friendsOf(user).length - 1; return n ? `You have ${n} friend${n === 1 ? '' : 's'} besides me. 👥` : 'You haven’t added anyone yet — search for a friend’s username in the Friends tab!'; }
  if (/\btime\b|\bdate\b|\btoday\b/.test(t)) return `It’s ${new Date().toUTCString()} (server time).`;
  if (/thank/.test(t)) return 'Anytime! 🤖';
  if (t.includes('?')) return `🎱 ${pick(EIGHT)}`;
  return pick(FALLBACK);
}
function botRespond(user, text) {
  notify([user], { type: 'typing', from: BOT });
  setTimeout(() => { if (db.users[user]) addMessage(BOT, user, botReply(user, text)); }, 700 + Math.random() * 900);
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, public: !!opts.public });
const U = '([a-z0-9_]{3,16})';

route('POST', '/api/signup', async ({ req, res }) => {
  if (limited(`signup:${clientIp(req)}`, 10, 3600e3)) throw new HttpError(429, 'Too many sign-ups from this address. Try again later.');
  const b = await readJson(req);
  const u = String(b.username || '').trim().toLowerCase();
  const pw = typeof b.password === 'string' ? b.password : '';
  if (!USERNAME_RE.test(u)) throw bad('Username must be 3–16 letters, numbers or underscores.');
  if (pw.length < 8 || pw.length > 200) throw bad('Password must be at least 8 characters.');
  if (db.users[u] || reserved(u)) throw new HttpError(409, 'That username is taken.');
  const { salt, hash } = await makeHash(pw);
  if (db.users[u]) throw new HttpError(409, 'That username is taken.');
  db.users[u] = { username: u, salt, hash, avatar: DEFAULT_AVATAR, setup: false, created: Date.now(), coins: 100, pets: [], emojis: [], tags: [], lastDaily: 0 };
  addMessage(BOT, u, 'Hey! I’m DANY AI 🤖 — Danychat’s built-in bot (a scripted one, not a person). Type “help” to see what I can do. Add real friends from the Friends tab!');
  send(res, 200, { ok: true }, { 'Set-Cookie': startSession(req, res, u) });
}, { public: true });

route('POST', '/api/login', async ({ req, res }) => {
  const ip = clientIp(req);
  const b = await readJson(req);
  const u = String(b.username || '').trim().toLowerCase();
  if (limited(`login-ip:${ip}`, 60, 900e3) || limited(`login:${ip}:${u}`, 10, 900e3)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const ok = await checkPw(db.users[u], typeof b.password === 'string' ? b.password : '');
  if (!ok) throw new HttpError(401, 'Wrong username or password.');
  hits.delete(`login:${ip}:${u}`);
  send(res, 200, { ok: true }, { 'Set-Cookie': startSession(req, res, u) });
}, { public: true });

route('POST', '/api/logout', ({ req, res }) => {
  const tok = parseCookies(req).dc_session;
  if (tok) { delete db.sessions[sha(tok)]; save(); }
  send(res, 200, { ok: true }, { 'Set-Cookie': 'dc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
}, { public: true });

route('GET', '/api/me', ({ res, me }) => {
  send(res, 200, {
    me: { ...userObj(me), setup: !!db.users[me].setup, coins: db.users[me].coins, pets: db.users[me].pets, emojis: EMOJIS.filter(e => db.users[me].emojis.includes(e.id)).map(({ id, emoji, name }) => ({ id, emoji, name })) },
    friends: friendsOf(me).map(userObj),
    incoming: incomingOf(me).map(u => decorate(u, me)),
    outgoing: outgoingOf(me).map(userObj),
  });
});

route('PUT', '/api/me/avatar', async ({ req, res, me }) => {
  const a = sanitizeAvatar((await readJson(req)).avatar, db.users[me].pets);
  if (!a) throw bad('Invalid avatar (you can only wear pets you own)');
  db.users[me].avatar = a; db.users[me].setup = true;
  save(); notify(friendsOf(me), { type: 'friends' });
  send(res, 200, { ok: true });
});

route('POST', '/api/me/password', async ({ req, res, me }) => {
  const b = await readJson(req);
  if (limited(`pw:${me}`, 10, 900e3)) throw new HttpError(429, 'Too many attempts. Try again later.');
  if (!(await checkPw(db.users[me], String(b.current || '')))) throw new HttpError(401, 'Current password is wrong.');
  const next = String(b.next || '');
  if (next.length < 8 || next.length > 200) throw bad('New password must be at least 8 characters.');
  Object.assign(db.users[me], await makeHash(next));
  const keep = sha(parseCookies(req).dc_session || '');
  for (const [k, s] of Object.entries(db.sessions)) if (s.u === me && k !== keep) delete db.sessions[k];   // sign out other devices
  save(); send(res, 200, { ok: true });
});

route('GET', '/api/users/search', ({ url, res, me }) => {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '').slice(0, 16);
  if (!q) return send(res, 200, { users: [] });
  const fr = new Set(friendsOf(me)), inc = new Set(incomingOf(me)), out = new Set(outgoingOf(me));
  const users = Object.keys(db.users).filter(u => u !== me && u.includes(q))
    .sort((a, b) => (b.startsWith(q) - a.startsWith(q)) || a.localeCompare(b)).slice(0, 15)
    .map(u => ({ ...decorate(u, me), following: !!db.follows[`${me}>${u}`], rel: fr.has(u) ? 'friend' : inc.has(u) ? 'incoming' : out.has(u) ? 'outgoing' : 'none' }));
  send(res, 200, { users });
});

route('POST', '/api/friends/request', async ({ req, res, me }) => {
  const to = String((await readJson(req)).to || '');
  if (limited(`freq:${me}`, 30, 3600e3)) throw new HttpError(429, 'Slow down — too many friend requests.');
  if (!db.users[to] || to === me) throw new HttpError(404, 'No such user');
  if (areFriends(me, to)) throw bad('Already friends');
  if (db.requests[`${to}>${me}`]) makeFriends(me, to);              // they already asked you — just connect
  else { db.requests[`${me}>${to}`] = Date.now(); save(); notify([to, me], { type: 'friends' }); }
  send(res, 200, { ok: true });
});
route('POST', '/api/friends/accept', async ({ req, res, me }) => {
  const from = String((await readJson(req)).from || '');
  if (!db.requests[`${from}>${me}`]) throw new HttpError(404, 'No such request');
  makeFriends(me, from); send(res, 200, { ok: true });
});
for (const [name, key] of [['decline', (me, o) => `${o}>${me}`], ['cancel', (me, o) => `${me}>${o}`]]) {
  route('POST', `/api/friends/${name}`, async ({ req, res, me }) => {
    const o = String((await readJson(req)).user || '');
    delete db.requests[key(me, o)]; save(); notify([me, o], { type: 'friends' }); send(res, 200, { ok: true });
  });
}
route('POST', '/api/friends/remove', async ({ req, res, me }) => {
  const o = String((await readJson(req)).user || '');
  if (o === BOT) throw bad('DANY AI is always your friend 🤖');
  delete db.friends[edgeKey(me, o)]; delete db.convs[convKey(me, o)]; delete db.streaks[edgeKey(me, o)];
  save(); notify([me, o], { type: 'friends' }); send(res, 200, { ok: true });
});

/* follows, recommendations, profiles */
route('POST', '/api/follow', async ({ req, res, me }) => {
  const to = String((await readJson(req)).user || '');
  if (!db.users[to] || to === me) throw new HttpError(404, 'No such user');
  if (!db.follows[`${me}>${to}`]) { db.follows[`${me}>${to}`] = Date.now(); save(); notify([to], { type: 'follow', by: me }); }
  send(res, 200, { ok: true, followers: followersOf(to).length });
});
route('POST', '/api/unfollow', async ({ req, res, me }) => {
  const to = String((await readJson(req)).user || '');
  delete db.follows[`${me}>${to}`]; save();
  send(res, 200, { ok: true, followers: followersOf(to).length });
});

// "People you may know": friends of your friends, ranked by how many friends you share. Real data only.
route('GET', '/api/recommendations', ({ res, me }) => {
  const adj = adjacency(), mine = adj.get(me) || new Set(), cand = new Map();
  const pending = new Set([...incomingOf(me), ...outgoingOf(me)]);
  for (const f of mine) for (const g of adj.get(f) || []) {
    if (g === me || mine.has(g) || pending.has(g) || !db.users[g]) continue;
    (cand.get(g) || cand.set(g, []).get(g)).push(f);
  }
  const users = [...cand].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([g, via]) => ({ ...userObj(g), mutual: via.length, mutualNames: via.slice(0, 2), following: !!db.follows[`${me}>${g}`] }));
  send(res, 200, { users });
});

route('GET', `/api/profile/${U}`, ({ res, me, m }) => {
  const u = m[1];
  if (!db.users[u]) throw new HttpError(404, 'No such user');
  const mutual = mutualWith(me, u);
  send(res, 200, {
    user: userObj(u), joined: db.users[u].created, isMe: u === me,
    stats: {
      posts: db.posts.filter(p => p.by === u && canSee(me, p)).length,
      reposts: db.reposts.filter(r => r.by === u && postCanSee(me, r.post)).length,
      friends: realFriends(u).length, followers: followersOf(u).length, following: followingOf(u).length,
    },
    rel: u === me ? null : {
      friend: areFriends(me, u), incoming: !!db.requests[`${u}>${me}`], outgoing: !!db.requests[`${me}>${u}`],
      following: !!db.follows[`${me}>${u}`], followedBy: !!db.follows[`${u}>${me}`],
    },
    mutual: mutual.length, mutualNames: mutual.slice(0, 3),
  });
});
route('GET', `/api/profile/${U}/posts`, ({ url, res, me, m }) => {
  const u = m[1];
  if (!db.users[u]) throw new HttpError(404, 'No such user');
  let posts;
  if (url.searchParams.get('kind') === 'reposts') {
    const byId = new Map(db.posts.map(p => [p.id, p]));
    posts = db.reposts.filter(r => r.by === u).map(r => { const p = byId.get(r.post); return p && canSee(me, p) ? { ...postView(p, me), repostedBy: userObj(u), t: r.t } : null; }).filter(Boolean);
  } else posts = db.posts.filter(p => p.by === u && canSee(me, p)).map(p => postView(p, me));
  send(res, 200, { posts: posts.sort((a, b) => b.t - a.t).slice(0, 60) });
});
for (const kind of ['followers', 'following']) {
  route('GET', `/api/profile/${U}/${kind}`, ({ res, me, m }) => {
    if (!db.users[m[1]]) throw new HttpError(404, 'No such user');
    const list = (kind === 'followers' ? followersOf : followingOf)(m[1]).filter(x => db.users[x]);
    send(res, 200, { users: list.map(x => ({ ...decorate(x, me), following: !!db.follows[`${me}>${x}`] })) });
  });
}

/* Dan Shop: pets for your avatar, bought with Dan Coins */
const DAILY_COINS = 25, DAILY_WAIT = 22 * 3600e3;
const shopState = me => {
  const u = db.users[me], wait = u.lastDaily + DAILY_WAIT - Date.now();
  return {
    coins: u.coins,
    pets: PETS.map((p, i) => ({ ...p, index: i + 1, owned: u.pets.includes(p.id) })),
    emojis: EMOJIS.map(e => ({ ...e, owned: u.emojis.includes(e.id) })),
    tags: TAGS.map(t => ({ ...t, owned: u.tags.includes(t.id) })),
    equippedTag: u.tag && u.tags.includes(u.tag) ? u.tag : null,
    daily: { amount: DAILY_COINS, available: wait <= 0, nextAt: wait > 0 ? Date.now() + wait : null },
  };
};
route('GET', '/api/shop', ({ res, me }) => send(res, 200, shopState(me)));
route('POST', '/api/mod/coins', ({ res, me }) => {
  if (!isMod(me)) throw new HttpError(403, 'Moderators only.');
  earn(me, MOD_COINS); save();
  send(res, 200, { earned: MOD_COINS, coins: db.users[me].coins });
});
// Buy a pet, an emoji sticker or a name tag: { kind: 'pet' | 'emoji' | 'tag', id }. (`{ pet }` still works.)
const CATALOGS = { pet: [PETS, 'pets'], emoji: [EMOJIS, 'emojis'], tag: [TAGS, 'tags'] };
route('POST', '/api/shop/buy', async ({ req, res, me }) => {
  const b = await readJson(req), kind = String(b.kind || 'pet'), wanted = String(b.id ?? b.pet ?? '');
  const cat = CATALOGS[kind];
  if (!cat) throw bad('Unknown kind of item');
  const item = cat[0].find(x => x.id === wanted);
  if (!item) throw new HttpError(404, `No such ${kind}`);
  const u = db.users[me], name = item.name || item.label;
  if (u[cat[1]].includes(item.id)) throw bad('You already own that.');
  if (u.coins < item.price) throw new HttpError(402, `Not enough Dan Coins — ${name} costs ${item.price}.`);
  u.coins -= item.price; u[cat[1]].push(item.id); save();
  send(res, 200, shopState(me));
});
// Wear (or remove) one of the name tags you own. It shows next to your name everywhere.
route('POST', '/api/shop/tag', async ({ req, res, me }) => {
  const id = (await readJson(req)).tag ?? null;
  const u = db.users[me];
  if (id !== null && !u.tags.includes(String(id))) throw new HttpError(403, 'Buy that tag in the Dan Shop first.');
  u.tag = id === null ? null : String(id); save();
  notify([...friendsOf(me), ...followersOf(me), me].filter(x => x !== BOT), { type: 'friends' });     // refresh name badges on their screens
  send(res, 200, shopState(me));
});
route('POST', '/api/shop/daily', ({ res, me }) => {
  const u = db.users[me];
  if (Date.now() - u.lastDaily < DAILY_WAIT) throw new HttpError(429, 'You already claimed your daily coins. Come back later!');
  u.lastDaily = Date.now(); earn(me, DAILY_COINS); save();
  send(res, 200, shopState(me));
});

route('GET', '/api/chats', ({ res, me }) => {
  send(res, 200, {
    chats: friendsOf(me).map(u => {
      const msgs = db.convs[convKey(me, u)] || [], last = msgs.at(-1);
      return { user: userObj(u), last: last ? { from: last.from, text: last.text, t: last.t, vanish: !!last.vanish } : null, unread: msgs.filter(m => m.to === me && !m.readAt).length, streak: u === BOT ? null : streakOf(me, u) };
    }),
  });
});
route('GET', `/api/messages/${U}`, ({ res, me, m }) => {
  assertFriend(me, m[1]);
  send(res, 200, { messages: (db.convs[convKey(me, m[1])] || []).slice(-200) });
});
route('POST', `/api/messages/${U}`, async ({ req, res, me, m }) => {
  assertFriend(me, m[1]);
  const b = await readJson(req);
  let text = String(b.text || '').trim(), sticker = null;
  if (b.sticker) {                                                         // a premium emoji: you must own it
    const em = EMOJIS.find(e => e.id === String(b.sticker));
    if (!em) throw bad('No such emoji');
    if (!db.users[me].emojis.includes(em.id)) throw new HttpError(403, 'Buy that emoji in the Dan Shop first.');
    text = em.emoji; sticker = em.id;
  }
  if (!text || text.length > 500) throw bad('Messages must be 1–500 characters.');
  if (limited(`msg:${me}`, 60, 60e3)) throw new HttpError(429, 'You’re sending messages too fast.');
  recordStreak(me, m[1]);
  const msg = addMessage(me, m[1], text, !!b.vanish, sticker);
  if (m[1] === BOT) botRespond(me, text);
  send(res, 200, { message: msg });
});
route('POST', `/api/messages/${U}/read`, ({ res, me, m }) => {
  assertFriend(me, m[1]);
  let n = 0;
  for (const msg of db.convs[convKey(me, m[1])] || []) if (msg.to === me && !msg.readAt) { msg.readAt = Date.now(); n++; }
  if (n) { save(); notify([m[1]], { type: 'read', by: me }); }
  send(res, 200, { ok: true });
});
route('POST', `/api/messages/${U}/close`, ({ res, me, m }) => {
  assertFriend(me, m[1]);
  const key = convKey(me, m[1]), removed = [];
  db.convs[key] = (db.convs[key] || []).filter(x => (x.vanish && x.readAt) ? (removed.push(x.id), false) : true);   // vanish messages disappear once seen
  if (removed.length) { save(); notify([me, m[1]], { type: 'purge', ids: removed }); }
  send(res, 200, { ok: true });
});

/* posts */
const canSee = (me, p) => p.by === me || p.public || areFriends(me, p.by);
const postCanSee = (me, id) => { const p = db.posts.find(x => x.id === id); return !!p && canSee(me, p); };
const postView = (p, me) => ({
  id: p.id, by: userObj(p.by), mine: p.by === me, caption: p.caption, t: p.t, public: p.public,
  likes: p.likes.length, dislikes: p.dislikes.length,
  reaction: p.likes.includes(me) ? 'like' : p.dislikes.includes(me) ? 'dislike' : null,
  reposts: db.reposts.filter(r => r.post === p.id).length, reposted: db.reposts.some(r => r.post === p.id && r.by === me),
  url: `/media/${p.id}`, audio: p.audio ? `/media/${p.id}/audio` : null,
});

// friends: you + friends (and their reposts) · following: public posts/reposts from people you follow · discover: everything public
function feedFor(me, tab) {
  const fr = new Set(friendsOf(me)), following = new Set(followingOf(me)), byId = new Map(db.posts.map(p => [p.id, p]));
  const items = [];
  if (tab === 'discover') {
    for (const p of db.posts) if (p.public || p.by === me) items.push(postView(p, me));
  } else {
    const inTab = u => (tab === 'friends' ? u === me || fr.has(u) : following.has(u));
    for (const p of db.posts) if (inTab(p.by) && (tab === 'friends' || p.public)) items.push(postView(p, me));
    for (const r of db.reposts) {
      const p = byId.get(r.post);
      if (p && inTab(r.by) && canSee(me, p)) items.push({ ...postView(p, me), repostedBy: userObj(r.by), t: r.t });
    }
  }
  items.sort((a, b) => b.t - a.t);
  const seen = new Set(), out = [];
  for (const i of items) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }      // one card per video
  return out.slice(0, 50);
}
route('GET', '/api/feed', ({ url, res, me }) => {
  const t = url.searchParams.get('tab');
  send(res, 200, { posts: feedFor(me, t === 'discover' || t === 'following' ? t : 'friends') });
});

// Streams an upload to disk (never into memory) and returns its first bytes for a magic-number check.
function receiveFile(req, tmp, max) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let n = 0, head = Buffer.alloc(0);
    req.on('data', c => {
      n += c.length;
      if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
      if (n > max) { req.unpipe(ws); ws.destroy(); reject(new HttpError(413, `File is too large (${Math.round(max / 1048576)} MB max).`)); }
    });
    req.on('aborted', () => { ws.destroy(); reject(bad('Upload aborted')); });
    ws.on('error', reject);
    ws.on('finish', () => resolve(head));
    req.pipe(ws);
  }).catch(e => { fs.rm(tmp, { force: true }, () => {}); throw e; });
}

const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const AUDIO_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba' };
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', weba: 'audio/webm' };
const MAX_AUDIO = 15 * 1024 * 1024;
const ascii = (h, from, to) => h.subarray(from, to).toString('latin1');
const isEbml = h => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3;
// The first bytes must match the container the client declared.
function looksLikeVideo(h, ext) {
  if (h.length < 12) return false;
  if (ext === 'webm') return isEbml(h);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(h, 4, 8));
}
function looksLikeAudio(h, ext) {
  if (h.length < 12) return false;
  if (ext === 'mp3') return ascii(h, 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0);
  if (ext === 'aac') return h[0] === 0xff && (h[1] & 0xf0) === 0xf0;
  if (ext === 'm4a') return ascii(h, 4, 8) === 'ftyp';
  if (ext === 'wav') return ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 12) === 'WAVE';
  if (ext === 'ogg') return ascii(h, 0, 4) === 'OggS';
  return isEbml(h);
}
const typeOf = req => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

route('POST', '/api/posts', async ({ req, res, me }) => {
  const ext = VIDEO_TYPES[typeOf(req)];
  if (!ext) throw new HttpError(415, 'Upload an MP4, WebM or MOV video.');
  if (+req.headers['content-length'] > MAX_VIDEO) throw new HttpError(413, 'Video is too large (60 MB max).');
  if (limited(`post:${me}`, 20, 3600e3)) throw new HttpError(429, 'Too many posts this hour.');
  let caption = '';
  try { caption = decodeURIComponent(req.headers['x-caption'] || ''); } catch { /* keep empty */ }
  caption = caption.trim().slice(0, 120);
  const id = rid(), tmp = path.join(VIDEO_DIR, `${id}.part`), file = `${id}.${ext}`;
  const head = await receiveFile(req, tmp, MAX_VIDEO);
  if (!looksLikeVideo(head, ext)) { fs.rmSync(tmp, { force: true }); throw new HttpError(415, 'That file doesn’t look like a valid video.'); }
  fs.renameSync(tmp, path.join(VIDEO_DIR, file));
  const post = { id, by: me, caption, file, audio: null, t: Date.now(), public: req.headers['x-public'] === '1', likes: [], dislikes: [] };
  db.posts.push(post);
  const earned = postReward(me);
  save();
  notify([...friendsOf(me), ...followersOf(me)].filter(u => u !== BOT), { type: 'post', by: me });
  send(res, 200, { post: postView(post, me), earned, coins: db.users[me].coins });
});

// Optional sound track for a post (music / voice-over). It plays instead of the video's own sound.
route('POST', '/api/posts/([a-f0-9]{16})/audio', async ({ req, res, me, m }) => {
  const post = db.posts.find(x => x.id === m[1] && x.by === me);
  if (!post) throw new HttpError(404, 'No such post');
  const ext = AUDIO_TYPES[typeOf(req)];
  if (!ext) throw new HttpError(415, 'Upload an MP3, M4A, AAC, WAV, OGG or WebM audio file.');
  if (+req.headers['content-length'] > MAX_AUDIO) throw new HttpError(413, 'Audio is too large (15 MB max).');
  const id = rid(), tmp = path.join(VIDEO_DIR, `${id}.part`), file = `${post.id}-a${id.slice(0, 6)}.${ext}`;
  const head = await receiveFile(req, tmp, MAX_AUDIO);
  if (!looksLikeAudio(head, ext)) { fs.rmSync(tmp, { force: true }); throw new HttpError(415, 'That file doesn’t look like valid audio.'); }
  fs.renameSync(tmp, path.join(VIDEO_DIR, file));
  if (post.audio) fs.rmSync(path.join(VIDEO_DIR, post.audio), { force: true });
  post.audio = file; save();
  send(res, 200, { post: postView(post, me) });
});

route('POST', '/api/posts/([a-f0-9]{16})/react', async ({ req, res, me, m }) => {
  const reaction = (await readJson(req)).reaction ?? null;
  if (![null, 'like', 'dislike'].includes(reaction)) throw bad('Invalid reaction');
  const p = db.posts.find(x => x.id === m[1]);
  if (!p || !canSee(me, p)) throw new HttpError(404, 'No such post');
  p.likes = p.likes.filter(u => u !== me); p.dislikes = p.dislikes.filter(u => u !== me);
  if (reaction === 'like') p.likes.push(me); else if (reaction === 'dislike') p.dislikes.push(me);
  save(); send(res, 200, { reaction, likes: p.likes.length, dislikes: p.dislikes.length });
});

// Reposting puts a public post on your profile and in your friends'/followers' feeds. Toggle.
route('POST', '/api/posts/([a-f0-9]{16})/repost', ({ res, me, m }) => {
  const p = db.posts.find(x => x.id === m[1]);
  if (!p || !canSee(me, p)) throw new HttpError(404, 'No such post');
  if (p.by === me) throw bad('You can’t repost your own video.');
  if (!p.public) throw bad('Only public posts can be reposted.');
  const i = db.reposts.findIndex(r => r.post === p.id && r.by === me);
  if (i >= 0) db.reposts.splice(i, 1); else db.reposts.push({ id: rid(), by: me, post: p.id, t: Date.now() });
  save(); send(res, 200, { reposted: i < 0, reposts: db.reposts.filter(r => r.post === p.id).length });
});

// Public = everyone can watch it on Discover and repost it. Private = friends only. The author can switch any time.
route('POST', '/api/posts/([a-f0-9]{16})/visibility', async ({ req, res, me, m }) => {
  const b = await readJson(req);
  if (typeof b.public !== 'boolean') throw bad('Send { public: true | false }');
  const p = db.posts.find(x => x.id === m[1] && x.by === me);
  if (!p) throw new HttpError(404, 'No such post');
  p.public = b.public;
  if (!p.public) db.reposts = db.reposts.filter(r => r.post !== p.id);      // reposts only exist for public videos
  save(); send(res, 200, { post: postView(p, me) });
});

route('DELETE', '/api/posts/([a-f0-9]{16})', ({ res, me, m }) => {
  const i = db.posts.findIndex(x => x.id === m[1] && (x.by === me || (isMod(me) && canSee(me, x))));   // authors, or mods for posts they can see
  if (i < 0) throw new HttpError(404, 'No such post');
  const p = db.posts[i];
  for (const f of [p.file, p.audio]) if (f) fs.rmSync(path.join(VIDEO_DIR, f), { force: true });
  db.posts.splice(i, 1);
  db.reposts = db.reposts.filter(r => r.post !== p.id);
  save();
  if (p.by !== me) {                                                       // a moderator removed someone else's video
    console.log(`[mod] ${me} removed post ${p.id} by ${p.by}`);
    notify([p.by], { type: 'notice', text: 'A moderator removed one of your videos.' });
  }
  send(res, 200, { ok: true });
});

/* scores */
route('GET', '/api/scores', ({ res, me }) => send(res, 200, { scores: myScores(me) }));
route('GET', '/api/scores/([a-z0-9]+)', ({ res, me, m }) => {
  const def = GAMES[m[1]];
  if (!def) throw new HttpError(404, 'No such game');
  const users = [me, ...friendsOf(me).filter(u => u !== BOT)];
  const board = users.filter(u => db.scores[m[1]]?.[u] != null).map(u => ({ user: userObj(u), value: db.scores[m[1]][u] }))
    .sort((a, b) => (better(def.mode, a.value, b.value) ? -1 : 1));
  send(res, 200, { board });
});
route('POST', '/api/scores', async ({ req, res, me }) => {
  const b = await readJson(req);
  const def = GAMES[b.game], score = b.score;
  if (!def || !Number.isFinite(score)) throw bad('Invalid score');
  const v = Math.round(score);
  if (def.mode === 'sum' ? (v < 1 || v > 5) : (v < (b.game === 'reaction' ? 60 : 1) || v > 1e6)) throw bad('Score out of range');
  const table = (db.scores[b.game] ||= {}), cur = table[me];
  if (def.mode === 'sum') table[me] = (cur || 0) + v;
  else if (cur == null || better(def.mode, v, cur)) table[me] = v;
  const earned = cur == null ? earn(me, 5) : 0;                       // +5 coins the first time you set a score in each game
  save(); send(res, 200, { best: table[me], earned, coins: db.users[me].coins });
});

/* calls — the server only relays WebRTC signalling; audio/video go directly between the two browsers */
const calls = new Map();                                                   // id -> { id, from, to, video, state, startedAt, timer }
const activeCallOf = u => [...calls.values()].find(c => c.from === u || c.to === u);
const fmtDur = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function endCall(call, reason) {
  if (!calls.has(call.id)) return;
  calls.delete(call.id); clearTimeout(call.timer);
  notify([call.from, call.to], { type: 'call-ended', id: call.id, reason });
  const icon = call.video ? '📹' : '📞', kind = call.video ? 'video' : 'voice';
  addMessage(call.from, call.to,
    call.state === 'active' ? `${icon} ${kind[0].toUpperCase() + kind.slice(1)} call · ${fmtDur(Math.max(1, Math.round((Date.now() - call.startedAt) / 1000)))}`
      : reason === 'declined' ? `${icon} Declined ${kind} call` : `${icon} Missed ${kind} call`);
}
const callFor = (id, me) => {
  const c = calls.get(id);
  if (!c || (c.from !== me && c.to !== me)) throw new HttpError(404, 'No such call');
  return c;
};
route('POST', '/api/calls', async ({ req, res, me }) => {
  const b = await readJson(req), to = String(b.to || '');
  if (to === BOT) throw bad('DANY AI is a bot — it can’t take calls.');
  assertFriend(me, to);
  if (limited(`call:${me}`, 20, 60e3)) throw new HttpError(429, 'Too many calls. Try again in a minute.');
  if (activeCallOf(me)) throw new HttpError(409, 'You’re already in a call.');
  if (!streams.has(to)) throw new HttpError(409, `${to} isn’t online right now.`);
  if (activeCallOf(to)) throw new HttpError(409, `${to} is on another call.`);
  const call = { id: rid(), from: me, to, video: !!b.video, state: 'ringing', startedAt: 0, timer: 0 };
  call.timer = setTimeout(() => endCall(call, 'missed'), 45e3);
  calls.set(call.id, call);
  notify([to], { type: 'call-invite', call: { id: call.id, video: call.video, from: userObj(me) } });
  send(res, 200, { call: { id: call.id } });
});
route('POST', '/api/calls/([a-f0-9]{16})/accept', ({ res, me, m }) => {
  const c = callFor(m[1], me);
  if (c.to !== me || c.state !== 'ringing') throw bad('Nothing to accept');
  c.state = 'active'; c.startedAt = Date.now(); clearTimeout(c.timer);
  c.timer = setTimeout(() => endCall(c, 'timeout'), 4 * 3600e3);
  notify([c.from], { type: 'call-accepted', id: c.id });
  send(res, 200, { ok: true });
});
route('POST', '/api/calls/([a-f0-9]{16})/decline', ({ res, me, m }) => {
  const c = callFor(m[1], me);
  if (c.to !== me || c.state !== 'ringing') throw bad('Nothing to decline');
  endCall(c, 'declined'); send(res, 200, { ok: true });
});
route('POST', '/api/calls/([a-f0-9]{16})/end', ({ res, me, m }) => {
  const c = callFor(m[1], me);
  endCall(c, c.state === 'ringing' && c.from === me ? 'cancelled' : 'hangup'); send(res, 200, { ok: true });
});
route('POST', '/api/calls/([a-f0-9]{16})/signal', async ({ req, res, me, m }) => {
  const c = callFor(m[1], me);
  if (c.state !== 'active') throw bad('Call is not connected yet');
  const data = (await readJson(req, 24 * 1024)).data;
  if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) throw bad('Invalid signal');
  notify([c.from === me ? c.to : c.from], { type: 'call-signal', id: c.id, from: me, data });
  send(res, 200, { ok: true });
});

/* realtime */
route('GET', '/api/events', ({ req, res, me }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!streams.has(me)) streams.set(me, new Set());
  streams.get(me).add(res);
  const hb = setInterval(() => res.write(': hb\n\n'), 25e3);
  req.on('close', () => {
    clearInterval(hb); const s = streams.get(me); s && s.delete(res); if (s && !s.size) streams.delete(me);
    if (!streams.has(me)) { const c = activeCallOf(me); if (c) endCall(c, 'dropped'); }      // closing the tab hangs up
  });
});

async function api(req, res, url) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (req.method !== 'GET' && req.headers['x-dc'] !== '1') throw new HttpError(403, 'Forbidden');   // blocks cross-site form posts
    const me = getSession(req);
    if (!r.public && !me) throw new HttpError(401, 'Please log in.');
    return r.handler({ req, res, url, me, m });
  }
  throw new HttpError(404, 'Not found');
}

/* ---------- media + static files ---------- */
function serveFile(req, res, fp, type, extra = {}) {
  let stat;
  try { stat = fs.statSync(fp); } catch { throw new HttpError(404, 'Not found'); }
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m && m[1] !== '' ? +m[1] : NaN, end = m && m[2] !== '' ? +m[2] : stat.size - 1;
    if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, stat.size - +m[2]); end = stat.size - 1; }   // suffix range
    end = Math.min(end, stat.size - 1);
    if (!m || Number.isNaN(start) || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(fp).pipe(res);
}

function media(req, res, id, kind) {
  const me = getSession(req);
  const p = db.posts.find(x => x.id === id);
  if (!me || !p || !canSee(me, p)) throw new HttpError(404, 'Not found');
  const file = kind === 'audio' ? p.audio : p.file;
  if (!file) throw new HttpError(404, 'Not found');
  const ext = path.extname(file).slice(1);
  const type = kind === 'audio' ? AUDIO_MIME[ext] : { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext];
  serveFile(req, res, path.join(VIDEO_DIR, file), type, { 'Cache-Control': 'private, max-age=3600' });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/avatar.js': ['avatar.js', 'text/javascript; charset=utf-8'],
  '/games.js': ['games.js', 'text/javascript; charset=utf-8'],
  '/logo.jpg': ['logo.jpg', 'image/jpeg'],
};
function staticFile(req, res, p) {
  const s = STATIC[p];
  if (!s || (req.method !== 'GET' && req.method !== 'HEAD')) throw new HttpError(404, 'Not found');
  serveFile(req, res, path.join(ROOT, s[0]), s[1], { 'Cache-Control': 'no-cache' });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (/^\/media\/[a-f0-9]{16}(\/audio)?$/.test(url.pathname)) media(req, res, url.pathname.slice(7, 23), url.pathname.endsWith('/audio') ? 'audio' : 'video');
    else staticFile(req, res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.end();
    const headers = status === 413 ? { Connection: 'close' } : {};
    if (req.url.startsWith('/api/')) send(res, status, { error: status === 500 ? 'Server error' : e.message }, headers);
    else { res.writeHead(status, { 'Content-Type': 'text/plain', ...headers }); res.end(status === 404 ? 'Not found' : 'Error'); }
    if (status === 413) res.once('finish', () => req.destroy());
  }
});
server.listen(PORT, HOST, () => console.log(`Danychat running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})`));
