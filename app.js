'use strict';

/* =====================================================================
   Danychat client. All data comes from the server (see server.js).
   The only simulated "person" anywhere is DANY AI, which the server runs.
   ===================================================================== */

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = n => Math.floor(Math.random() * n);
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Builds DOM nodes without innerHTML, so user-provided text can never inject markup.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// Shop tag: cosmetic only. The colours come from the server's fixed catalog; we still only accept plain hex colours.
const HEX = /^#[0-9a-f]{6}$/i;
const tagNode = t => (t && HEX.test(t.bg) && HEX.test(t.fg) ? el('span', { class: 'tag custom', style: `background:${t.bg};color:${t.fg}`, text: t.label }) : null);
const nameNode = u => el('span', {}, u.name, u.bot ? el('span', { class: 'tag', text: 'BOT' }) : null, u.mod ? el('span', { class: 'tag mod', title: 'Moderator', text: '🔨 MOD' }) : null, tagNode(u.tag));

// Sound is on by default and the choice is remembered on this device
// (a browser may still hold sound back until you've tapped something on the page).
const soundOn = () => { try { return localStorage.getItem('danychat:sound') !== '0'; } catch { return true; } };
const setSoundPref = on => { try { localStorage.setItem('danychat:sound', on ? '1' : '0'); } catch { /* private mode */ } };

/* ---------- API ---------- */
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
let loggedIn = false;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-DC': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError('Can’t reach the Danychat server.', 0); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && loggedIn) sessionExpired();
    throw new ApiError((data && data.error) || 'Something went wrong.', res.status);
  }
  return data;
}
const quiet = p => p.catch(() => {});   // for fire-and-forget calls

/* ---------- state ---------- */
let me = null, friends = [], incoming = [], outgoing = [], convos = [];
let currentTab = null;

function setCoins(n) { if (me) me.coins = n; $('#btn-coins').textContent = `🪙 ${n}`; }
// Pass any API response that may carry Dan Coin rewards ({ earned, coins }).
function gain(d) { if (d && d.coins != null) setCoins(d.coins); if (d && d.earned > 0) toast(`+${d.earned} 🪙 Dan Coins!`); }

async function loadMe() {
  const d = await api('GET', '/me');
  me = d.me; friends = d.friends; incoming = d.incoming; outgoing = d.outgoing;
}
async function refreshConvos() {
  convos = (await api('GET', '/chats')).chats;
  updateBadges();
  if (thread) paintThreadStreak();
  if (currentTab === 'chat' && !thread) renderChat();
}
function updateBadges() {
  const unread = convos.reduce((n, c) => n + c.unread, 0);
  const a = $('#badge-chat'), b = $('#badge-friends');
  a.hidden = !unread; a.textContent = unread;
  b.hidden = !incoming.length; b.textContent = incoming.length;
}

/* ---------- modal + overlay helpers ---------- */
let closeModalFn = null;
function openModal(content, { dismissible = true, onClose } = {}) {
  closeModal();
  const backdrop = el('div', { class: 'backdrop', onclick: e => { if (dismissible && e.target === backdrop) closeModal(); } },
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content));
  $('#overlay-root').append(backdrop);
  closeModalFn = () => { backdrop.remove(); closeModalFn = null; onClose && onClose(); };
  return closeModalFn;
}
const closeModal = () => closeModalFn && closeModalFn();
// Profile pages and the full-screen video viewer stack on top of everything; this clears them all.
function closeOverlays() { $$('.viewer, .page').forEach(n => (n.__close ? n.__close() : n.remove())); closeModal(); }

/* =====================================================================
   Auth
   ===================================================================== */
function showAuth(message) {
  loggedIn = false;
  closeEvents(); closeOverlays(); closeThread(); stopGame(); endCallLocal();
  $('#shell').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  let mode = 'login';
  const err = el('p', { class: 'error', role: 'alert', text: message || '' });
  const user = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', maxlength: '16', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Username' });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const pass2 = el('input', { type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password', 'aria-label': 'Confirm password', hidden: true });
  const submit = el('button', { class: 'btn primary wide', type: 'submit', text: 'Log in' });
  const hint = el('p', { class: 'auth-hint' });
  const switcher = el('button', { class: 'linkish', type: 'button' });

  function setMode(m) {
    mode = m; err.textContent = '';
    pass2.hidden = m === 'login';
    pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    submit.textContent = m === 'login' ? 'Log in' : 'Create account';
    hint.textContent = m === 'login' ? 'New to Danychat?' : 'Already have an account?';
    switcher.textContent = m === 'login' ? 'Sign up' : 'Log in';
  }
  switcher.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

  const form = el('form', { class: 'auth-form', onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    const u = user.value.trim().toLowerCase(), p = pass.value;
    if (mode === 'signup') {
      if (!/^[a-z0-9_]{3,16}$/.test(u)) { err.textContent = 'Username: 3–16 letters, numbers or underscores.'; return; }
      if (p.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
      if (p !== pass2.value) { err.textContent = 'Passwords don’t match.'; return; }
    }
    submit.disabled = true;
    try {
      await api('POST', mode === 'signup' ? '/signup' : '/login', { username: u, password: p });
      await loadMe();
      enterApp();
    } catch (ex) { err.textContent = ex.message; }
    finally { submit.disabled = false; }
  } }, user, pass, pass2, err, submit);

  const logo = textLogo('lg');
  box.replaceChildren(el('div', { class: 'auth-card' }, logo, el('h1', { text: 'Danychat' }),
    el('p', { class: 'auth-tag', text: 'Chat, watch and play with your friends.' }),
    form, el('div', { class: 'auth-switch' }, hint, switcher)));
  setMode('login');
  user.focus();
}

// The logo: the name, one word per line.
function textLogo(size = '') {
  return el('div', { class: `text-logo ${size}`.trim(), role: 'img', 'aria-label': 'Dany Fuad Dahan' }, ['Dany', 'Fuad', 'Dahan'].map(w => el('span', { 'aria-hidden': 'true', text: w })));
}

function sessionExpired() { me = null; showAuth('Your session ended. Please log in again.'); }

async function logout() {
  await quiet(api('POST', '/logout'));
  me = null; loggedIn = false; friends = []; incoming = []; outgoing = []; convos = [];
  location.hash = '';
  showAuth();
}

function enterApp() {
  loggedIn = true;
  $('#auth').hidden = true; $('#shell').hidden = false;
  setMeButton(); setCoins(me.coins);
  connectEvents();
  refreshConvos().catch(() => {});
  renderFriends(); updateBadges();
  showTab(location.hash.slice(1) || 'watch');
  if (!me.setup) openAvatarEditor({ first: true });
}
function setMeButton() { $('#btn-me').replaceChildren(avatarEl(me, 'sm')); }

/* =====================================================================
   Avatar editor (Bitmoji-style)
   ===================================================================== */
const AV_TABS = [
  { label: 'Skin',      controls: [{ key: 'skin', title: 'Skin tone', palette: AV.skin.map(s => s[0]) }] },
  { label: 'Hair',      controls: [{ key: 'hair', title: 'Style', values: HAIR_IDS }, { key: 'hairColor', title: 'Color', palette: AV.hairColor }] },
  { label: 'Face',      controls: [{ key: 'eyes', title: 'Eyes', count: AV_COUNTS.eyes }, { key: 'brows', title: 'Brows', count: AV_COUNTS.brows }, { key: 'mouth', title: 'Mouth', count: AV_COUNTS.mouth }] },
  { label: 'Extras',    controls: [{ key: 'beard', title: 'Facial hair', count: AV_COUNTS.beard }, { key: 'extras', title: 'Freckles & blush', count: AV_COUNTS.extras }] },
  { label: 'Outfit',    controls: [{ key: 'outfit', title: 'Style', count: AV_COUNTS.outfit }, { key: 'outfitColor', title: 'Color', palette: AV.outfitColor }] },
  { label: 'Accessories', controls: [{ key: 'glasses', title: 'Glasses', count: AV_COUNTS.glasses }, { key: 'hat', title: 'Hat', count: AV_COUNTS.hat }, { key: 'hatColor', title: 'Hat color', palette: AV.hatColor }] },
  { label: 'Pets',      pets: true },
  { label: 'Background', controls: [{ key: 'bg', title: 'Color', palette: AV.bg }] },
];

function openAvatarEditor({ first = false } = {}) {
  let cfg = { ...DEFAULT_AVATAR, ...(me.avatar || {}) };
  if (!HAIR_IDS.includes(cfg.hair)) cfg.hair = 1;                     // a retired hair style falls back to the classic short cut
  let tab = 0;
  const preview = el('div', { class: 'ed-preview' });
  const tabs = el('div', { class: 'tabs-scroll', role: 'tablist' });
  const opts = el('div', { class: 'ed-opts' });
  const err = el('p', { class: 'error' });
  const save = el('button', { class: 'btn primary grow', text: first ? 'Save & continue' : 'Save', type: 'button' });

  function petOptions() {
    const owned = PET_IDS.map((id, i) => [id, i + 1]).filter(([id]) => (me.pets || []).includes(id));
    const choices = [0, ...owned.map(o => o[1])];
    return [
      el('div', { class: 'grp' }, el('div', { class: 'grp-title', text: 'Your pets' }),
        el('div', { class: 'opt-row' }, choices.map(i => el('button', { class: `opt${cfg.pet === i ? ' on' : ''}`, type: 'button', 'aria-label': i ? PET_IDS[i - 1] : 'No pet', onclick: () => { cfg.pet = i; render(); } },
          avatarEl({ avatar: { ...cfg, pet: i } }, 'xs')))),
        owned.length ? null : el('p', { class: 'muted', text: 'You don’t own any pets yet.' })),
      el('button', { class: 'btn', type: 'button', text: '🛍 Open the Dan Shop', onclick: () => { closeModal(); openShop(); } }),
    ];
  }
  function render() {
    preview.replaceChildren(avatarEl({ avatar: cfg }, 'xl'));
    tabs.replaceChildren(...AV_TABS.map((t, i) => el('button', { class: `chip${i === tab ? ' on' : ''}`, role: 'tab', 'aria-selected': String(i === tab), text: t.label, onclick: () => { tab = i; render(); } })));
    if (AV_TABS[tab].pets) { opts.replaceChildren(...petOptions()); return; }
    opts.replaceChildren(...AV_TABS[tab].controls.map(ctl => el('div', { class: 'grp' },
      el('div', { class: 'grp-title', text: ctl.title }),
      el('div', { class: 'opt-row' }, ctl.palette
        ? ctl.palette.map((color, i) => el('button', { class: `swatch${cfg[ctl.key] === i ? ' on' : ''}`, style: `background:${color}`, 'aria-label': `${ctl.title} ${i + 1}`, type: 'button', onclick: () => { cfg[ctl.key] = i; render(); } }))
        : (ctl.values || Array.from({ length: ctl.count }, (_, i) => i)).map((v, n) => el('button', { class: `opt${(ctl.values ? cfg[ctl.key] : cfg[ctl.key] % ctl.count) === v ? ' on' : ''}`, 'aria-label': `${ctl.title} ${n + 1}`, type: 'button', onclick: () => { cfg[ctl.key] = v; render(); } }, avatarEl({ avatar: { ...cfg, [ctl.key]: v } }, 'xs')))))));
  }
  save.addEventListener('click', async () => {
    save.disabled = true; err.textContent = '';
    try {
      await api('PUT', '/me/avatar', { avatar: cfg });
      me.avatar = cfg; me.setup = true;
      setMeButton(); closeModal(); refreshSocial(); if (currentTab === 'watch') renderWatch();
      toast('Avatar saved ✨');
    } catch (ex) { err.textContent = ex.message; save.disabled = false; }
  });
  openModal([
    el('h2', { text: first ? 'Create your avatar' : 'Edit your avatar' }),
    el('p', { text: 'This is how your friends see you in chats and videos.' }),
    preview, tabs, opts, err,
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: '🎲 Randomize', onclick: () => { cfg = { ...randomAvatar(), pet: cfg.pet }; render(); } }),
      first ? null : el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => closeModal() }),
      save),
  ], { dismissible: !first });
  render();
}

/* =====================================================================
   Dan Shop — pets for your avatar, bought with Dan Coins
   ===================================================================== */
async function openShop(startTab = 'pets') {
  let tab = startTab, state = null;
  const box = el('div', { class: 'shop' }, el('p', { class: 'empty', text: 'Loading…' }));
  openModal([el('h2', { text: '🛍 Dan Shop' }), box]);

  const apply = st => {
    state = st;
    me.pets = st.pets.filter(p => p.owned).map(p => p.id);
    me.emojis = st.emojis.filter(e => e.owned).map(({ id, emoji, name }) => ({ id, emoji, name }));
    const worn = st.tags.find(t => t.id === st.equippedTag);
    me.tag = worn ? { label: worn.label, bg: worn.bg, fg: worn.fg } : undefined;
    setCoins(st.coins);
    paint();
  };
  const run = async (fn, ok) => { try { apply(await fn()); if (ok) toast(ok); if (currentTab === 'me') renderProfile($('#view-me'), me.username); } catch (ex) { toast(ex.message); } };
  const buy = (kind, item, label) => run(() => api('POST', '/shop/buy', { kind, id: item.id }), `You got ${label}! 🎉`);
  const wear = async (index, msg) => {
    try { await api('PUT', '/me/avatar', { avatar: { ...me.avatar, pet: index } }); me.avatar = { ...me.avatar, pet: index }; setMeButton(); toast(msg); refreshSocial(); if (currentTab === 'me') renderProfile($('#view-me'), me.username); paint(); }
    catch (ex) { toast(ex.message); }
  };
  const buyBtn = (kind, item, label) => el('button', { class: 'btn primary', text: `Buy · 🪙 ${item.price}`, disabled: state.coins < item.price, title: state.coins < item.price ? 'Not enough Dan Coins yet' : '', onclick: () => buy(kind, item, label) });

  const petCards = () => {
    const worn = (me.avatar && me.avatar.pet) || 0;
    return state.pets.map(p => el('div', { class: `pet-card${worn === p.index ? ' worn' : ''}` },
      avatarEl({ avatar: { ...me.avatar, pet: p.index } }, 'lg'),
      el('div', { class: 'pet-name', text: p.name }),
      p.owned
        ? (worn === p.index
          ? el('button', { class: 'btn', text: 'Unequip', onclick: () => wear(0, `${p.name} says bye 👋`) })
          : el('button', { class: 'btn primary', text: 'Equip', onclick: () => wear(p.index, `${p.name} joined your avatar!`) }))
        : buyBtn('pet', p, p.name)));
  };
  const emojiCards = () => state.emojis.map(e => el('div', { class: 'shop-card' },
    el('div', { class: 'shop-emoji', text: e.emoji }), el('div', { class: 'pet-name', text: e.name }),
    e.owned ? el('span', { class: 'muted small', text: 'Owned ✓ — in every chat' }) : buyBtn('emoji', e, `the ${e.name} emoji`)));
  const tagCards = () => state.tags.map(t => {
    const worn = state.equippedTag === t.id;
    return el('div', { class: `shop-card${worn ? ' worn' : ''}` },
      el('div', { class: 'tag-preview' }, nameNode({ name: me.username, mod: me.mod, tag: t })),
      t.owned
        ? (worn ? el('button', { class: 'btn', text: 'Unequip', onclick: () => run(() => api('POST', '/shop/tag', { tag: null }), 'Tag removed') })
          : el('button', { class: 'btn primary', text: 'Equip', onclick: () => run(() => api('POST', '/shop/tag', { tag: t.id }), 'Tag equipped — it shows next to your name!') }))
        : buyBtn('tag', t, `the ${t.label} tag`));
  });

  function paint() {
    const st = state;
    const daily = st.daily.available
      ? el('button', { class: 'btn primary', text: `Claim daily bonus +${st.daily.amount} 🪙`, onclick: () => run(() => api('POST', '/shop/daily'), `+${st.daily.amount} 🪙 claimed!`) })
      : el('button', { class: 'btn', disabled: true, text: 'Daily bonus claimed ✓' });
    const notes = {
      pets: 'Pets sit on your avatar’s shoulder — pick one in the avatar editor or here.',
      emojis: 'Emojis you own show up in every chat’s emoji bar and send as big animated stickers.',
      tags: 'A tag shows next to your name everywhere. Tags are just for style — they don’t give any powers.',
    };
    box.replaceChildren(
      el('div', { class: 'wallet' }, el('div', {}, el('div', { class: 'muted', text: 'Your balance' }), el('strong', { class: 'bal', text: `🪙 ${st.coins}` })), daily),
      el('p', { class: 'muted small', text: 'Earn Dan Coins: +25 daily · +10 for each of your first 3 posts a day · +5 the first time you set a score in each game · +15 for each new friend (up to 5 a day).' }),
      el('div', { class: 'tabs-scroll', role: 'tablist' }, [['pets', '🐾 Pets'], ['emojis', '😀 Emojis'], ['tags', '🏷️ Tags']].map(([id, label]) =>
        el('button', { class: `chip${tab === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === id), text: label, onclick: () => { tab = id; paint(); } }))),
      el('p', { class: 'muted small', text: notes[tab] }),
      el('div', { class: 'shop-grid' }, tab === 'pets' ? petCards() : tab === 'emojis' ? emojiCards() : tagCards()),
      el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Close', onclick: closeModal })));
  }
  try { apply(await api('GET', '/shop')); } catch (ex) { box.replaceChildren(el('p', { class: 'empty', text: ex.message })); }
}

/* =====================================================================
   Settings
   ===================================================================== */
function openSettings() {
  const pwErr = el('p', { class: 'error' });
  const cur = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const nxt = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', 'aria-label': 'New password' });
  const pwBox = el('form', { class: 'pw-form', hidden: true, onsubmit: async e => {
    e.preventDefault(); pwErr.textContent = '';
    try { await api('POST', '/me/password', { current: cur.value, next: nxt.value }); toast('Password changed'); closeModal(); }
    catch (ex) { pwErr.textContent = ex.message; }
  } }, cur, nxt, pwErr, el('button', { class: 'btn primary wide', type: 'submit', text: 'Update password' }));
  openModal([
    el('h2', { text: 'Settings' }),
    el('div', { class: 'stack' },
      el('button', { class: 'btn', text: '🔑 Change password', onclick: () => { pwBox.hidden = !pwBox.hidden; } }),
      pwBox,
      el('button', { class: 'btn danger', text: 'Log out', onclick: () => { closeModal(); logout(); } }),
      el('button', { class: 'btn', text: 'Close', onclick: closeModal })),
  ]);
}

/* =====================================================================
   Realtime events (Server-Sent Events)
   ===================================================================== */
let es = null, esWasOpen = false, typingTimer = 0;
function connectEvents() {
  closeEvents();
  es = new EventSource('/api/events');
  es.onopen = () => { if (esWasOpen) { loadMe().then(refreshSocial).catch(() => {}); } esWasOpen = true; };
  es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
}
function closeEvents() { if (es) es.close(); es = null; esWasOpen = false; }

function onEvent(ev) {
  if (ev.type === 'message') {
    const msg = ev.msg, other = msg.from === me.username ? msg.to : msg.from;
    if (thread && thread.user.username === other) {
      appendMsg(msg);
      if (msg.to === me.username) quiet(api('POST', `/messages/${other}/read`));
    } else if (msg.to === me.username) {
      const u = friends.find(f => f.username === msg.from);
      toast(`${u ? u.name : msg.from}: ${msg.text}`);
    }
    refreshConvos().catch(() => {});
  } else if (ev.type === 'friends') {
    loadMe().then(refreshSocial).catch(() => {});
  } else if (ev.type === 'follow') {
    toast(`${ev.by} started following you`);
    if (currentTab === 'me') renderProfile($('#view-me'), me.username);
  } else if (ev.type === 'read') {
    if (thread && thread.user.username === ev.by) { thread.msgs.filter(m => m.from === me.username && !m.readAt).forEach(m => { m.readAt = Date.now(); }); updateSeen(); }
  } else if (ev.type === 'purge') {
    if (thread) { thread.msgs = thread.msgs.filter(m => !ev.ids.includes(m.id)); ev.ids.forEach(id => { const n = thread.nodes.get(id); if (n) n.remove(); thread.nodes.delete(id); }); updateSeen(); }
    refreshConvos().catch(() => {});
  } else if (ev.type === 'typing') {
    if (thread && thread.user.username === ev.from) {
      thread.typingEl.hidden = false; thread.list.scrollTop = thread.list.scrollHeight;
      clearTimeout(typingTimer); typingTimer = setTimeout(() => { if (thread) thread.typingEl.hidden = true; }, 3000);
    }
  } else if (ev.type === 'post') {
    toast(`${ev.by} posted a new video 🎬`);
    if (currentTab === 'watch') showNewPostsChip();
  } else if (ev.type === 'notice') {
    toast(ev.text);
  } else if (ev.type === 'coins') {
    setCoins(ev.coins); toast(`+${ev.amount} 🪙 Dan Coins for making a new friend!`);
  } else if (ev.type.startsWith('call-')) {
    onCallEvent(ev);
  }
}

/* =====================================================================
   Tabs
   ===================================================================== */
const TABS = ['chat', 'watch', 'games', 'friends', 'me'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'watch';
  if (name !== 'games') stopGame();
  currentTab = name;
  TABS.forEach(t => { $(`#view-${t}`).hidden = t !== name; });
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#btn-post').hidden = name !== 'watch';
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  if (name === 'chat') { renderChat(); refreshConvos().catch(() => {}); }
  if (name === 'games') renderGames();
  if (name === 'watch') renderWatch();
  if (name === 'friends') renderFriends();
  if (name === 'me') renderProfile($('#view-me'), me.username);
}

/* =====================================================================
   Chat
   ===================================================================== */
function renderChat() {
  const v = $('#view-chat');
  v.replaceChildren(el('h2', { text: 'Chats' }));
  const sorted = [...convos].sort((a, b) => (b.last?.t || 0) - (a.last?.t || 0));
  for (const c of sorted) {
    v.append(el('button', { class: 'row', onclick: () => openThread(c.user) },
      avatarEl(c.user),
      el('div', { class: `grow ${c.unread ? 'unread' : ''}` },
        el('div', { class: 'name' }, nameNode(c.user), streakBadge(c.streak)),
        el('div', { class: 'sub', text: c.last ? `${c.last.from === me.username ? 'You: ' : ''}${c.last.text}` : 'Say hi 👋' })),
      c.unread ? el('span', { class: 'count', text: String(c.unread), 'aria-label': `${c.unread} unread` }) : null));
  }
  if (sorted.length <= 1) v.append(el('p', { class: 'empty', text: 'Add friends in the Friends tab to start chatting with real people.' }));
}

const EMOJI_COOLDOWN_MS = 2000;

// Streaks (like a Snap streak): +1 for every calendar day on which you BOTH messaged each other; it ends if a day is missed.
function streakBadge(s) {
  if (!s || s.count < 2) return null;
  return el('span', { class: `streak${s.atRisk ? ' risk' : ''}`, title: `${s.count}-day streak${s.atRisk ? ' — message each other today to keep it!' : ''}`, text: `🔥${s.count}${s.atRisk ? ' ⏳' : ''}` });
}
function streakText(s, user) {
  if (!s || s.count < 1) return '';
  const wait = s.you && !s.them ? `waiting for ${user.name}` : 'message today to keep it';
  if (s.count >= 2) return s.atRisk ? `🔥 ${s.count}-day streak · ⏳ ${wait}` : `🔥 ${s.count}-day streak`;
  return s.atRisk ? `⏳ ${wait.replace('keep it', 'start a streak')}` : '🌱 day 1 done — message tomorrow to start a streak';
}
function paintThreadStreak() {
  if (!thread || thread.user.bot) return;
  const c = convos.find(x => x.user.username === thread.user.username), t = c ? streakText(c.streak, thread.user) : '';
  thread.subEl.textContent = `@${thread.user.username}${t ? ` · ${t}` : ''}`;
}
let thread = null;   // { user, node, list, typingEl, msgs, nodes: Map, vanish }

function bubble(m) {
  const who = m.from === me.username ? 'me' : 'them';
  if (m.sticker) return el('div', { class: `bubble sticker ${who}` }, el('span', { class: 'sticker-emoji', text: m.text }), el('time', { text: fmtTime(m.t) }));    // premium emoji: big + animated
  return el('div', { class: `bubble ${who}${m.vanish ? ' vanish' : ''}` }, m.text, el('time', { text: fmtTime(m.t) }));
}
function appendMsg(m) {
  if (!thread || thread.nodes.has(m.id)) return;
  thread.msgs.push(m);
  const n = bubble(m);
  thread.nodes.set(m.id, n);
  thread.list.insertBefore(n, thread.typingEl);
  if (m.from !== me.username) thread.typingEl.hidden = true;
  thread.list.scrollTop = thread.list.scrollHeight;
  updateSeen();
}
function updateSeen() {
  if (!thread) return;
  $$('.seen', thread.list).forEach(n => n.remove());
  const last = thread.msgs.at(-1);
  if (last && last.from === me.username && last.readAt && !thread.user.bot) {
    const n = thread.nodes.get(last.id);
    if (n) n.after(el('div', { class: 'seen', text: 'Seen' }));
  }
}

async function openThread(user) {
  closeThread();
  const list = el('div', { class: 'msgs' });
  const typingEl = el('div', { class: 'typing', hidden: true, text: `${user.name} is typing…` });
  const input = el('input', { type: 'text', placeholder: `Message ${user.name}`, maxlength: '500', autocomplete: 'off', 'aria-label': 'Message' });
  const vanishBtn = el('button', { class: 'vanish-toggle', type: 'button', title: 'Messages sent in vanish mode disappear after they’re seen and the chat is closed',
    onclick: () => { thread.vanish = !thread.vanish; vanishBtn.classList.toggle('on', thread.vanish); toast(thread.vanish ? '👻 Vanish mode on' : 'Vanish mode off'); } }, '👻 Vanish');
  const send = async text => {
    text = text.trim();
    if (!text) return;
    try { const d = await api('POST', `/messages/${user.username}`, { text, vanish: thread ? thread.vanish : false }); appendMsg(d.message); }
    catch (ex) { toast(ex.message); }
  };
  // Free emojis and any premium stickers you own share one cooldown: after each tap they lock for a couple of seconds so they can't be spammed.
  const sendSticker = async id => {
    try { const d = await api('POST', `/messages/${user.username}`, { sticker: id, vanish: thread ? thread.vanish : false }); appendMsg(d.message); }
    catch (ex) { toast(ex.message); }
  };
  const coolBar = el('div', { class: 'cool-bar' });
  let quickBtns = [];
  const tap = fn => () => {
    if (quickBtns[0].disabled) return;
    fn();
    quickBtns.forEach(b => { b.disabled = true; });
    coolBar.classList.remove('run'); void coolBar.offsetWidth; coolBar.classList.add('run');
    setTimeout(() => { quickBtns.forEach(b => { b.disabled = false; }); coolBar.classList.remove('run'); }, EMOJI_COOLDOWN_MS);
  };
  const emojiBtns = ['😂', '❤️', '🔥', '👍', '👀', '🎮'].map(e => el('button', { type: 'button', text: e, 'aria-label': `Send ${e}`, onclick: tap(() => send(e)) }));
  const stickerBtns = (me.emojis || []).map(s => el('button', { type: 'button', class: 'sticker-btn', text: s.emoji, title: `${s.name} sticker`, 'aria-label': `Send ${s.name} sticker`, onclick: tap(() => sendSticker(s.id)) }));
  quickBtns = [...emojiBtns, ...stickerBtns];
  const moreBtn = el('button', { type: 'button', class: 'more-btn', text: '＋', title: 'Get more emojis in the Dan Shop', 'aria-label': 'Get more emojis', onclick: () => openShop('emojis') });
  const subEl = el('div', { class: 'sub', text: user.bot ? 'Scripted bot — not a person' : `@${user.username}` });
  const node = el('div', { class: 'thread' },
    el('div', { class: 'thread-head' },
      el('button', { class: 'btn', text: '←', 'aria-label': 'Back', onclick: () => { closeThread(); renderChat(); } }),
      avatarEl(user, 'sm'),
      el('div', { class: 'grow' }, el('div', { class: 'name' }, nameNode(user)), subEl),
      user.bot ? null : el('button', { class: 'btn', text: '📞', 'aria-label': 'Voice call', title: 'Voice call', onclick: () => startCall(user, false) }),
      user.bot ? null : el('button', { class: 'btn', text: '📹', 'aria-label': 'Video call', title: 'Video call', onclick: () => startCall(user, true) })),
    list,
    el('div', { class: 'thread-foot' },
      el('div', { class: 'quick' }, emojiBtns, stickerBtns, moreBtn, vanishBtn),
      coolBar,
      el('form', { class: 'composer', onsubmit: e => { e.preventDefault(); const t = input.value; input.value = ''; send(t); } },
        input, el('button', { class: 'btn primary', type: 'submit', text: 'Send' }))));
  thread = { user, node, list, typingEl, subEl, msgs: [], nodes: new Map(), vanish: false };
  paintThreadStreak();
  list.append(typingEl);
  $('#overlay-root').append(node);
  input.focus();
  try {
    const d = await api('GET', `/messages/${user.username}`);
    if (!thread || thread.node !== node) return;
    d.messages.forEach(m => appendMsg(m));
    list.scrollTop = list.scrollHeight;
    if (d.messages.some(m => m.to === me.username && !m.readAt)) { await quiet(api('POST', `/messages/${user.username}/read`)); refreshConvos().catch(() => {}); }
  } catch (ex) { toast(ex.message); }
}

function closeThread() {
  if (!thread) return;
  quiet(api('POST', `/messages/${thread.user.username}/close`));    // vanish-mode messages that were seen get deleted
  thread.node.remove();
  thread = null;
  refreshConvos().catch(() => {});
}

/* =====================================================================
   People: rows, friends, recommendations, followers
   ===================================================================== */
let friendQuery = '', searchResults = [], searchSeq = 0, searchTimer = 0;

function mutualText(u) {
  if (!u.mutual) return '';
  const names = u.mutualNames && u.mutualNames.length ? `: ${u.mutualNames.join(', ')}${u.mutual > u.mutualNames.length ? '…' : ''}` : '';
  return `${plural(u.mutual, 'mutual friend')}${names}`;
}
// A person row; tapping the name/avatar opens their profile page.
function personRow(u, ...actions) {
  const sub = u.bot ? 'Scripted bot' : [`@${u.username}`, mutualText(u)].filter(Boolean).join(' · ');
  const who = el(u.bot ? 'div' : 'button', { class: 'who-btn', type: u.bot ? null : 'button', 'aria-label': u.bot ? null : `View ${u.name}’s profile`, onclick: u.bot ? null : () => openProfilePage(u.username) },
    avatarEl(u), el('div', { class: 'grow' }, el('div', { class: 'name' }, nameNode(u)), el('div', { class: 'sub', text: sub })));
  return el('div', { class: 'row' }, who, ...actions);
}

async function friendAction(path, body, okMsg) {
  try { await api('POST', '/friends/' + path, body); if (okMsg) toast(okMsg); }
  catch (ex) { toast(ex.message); }
  await loadMe().catch(() => {});
  refreshSocial();
  if (friendQuery.trim()) runSearch();
}
const addBtn = u => el('button', { class: 'btn primary', text: 'Add', onclick: () => friendAction('request', { to: u.username }, `Request sent to ${u.name}`) });

function renderFriends() {
  const v = $('#view-friends');
  const search = el('input', { type: 'search', placeholder: 'Search by username', value: friendQuery, autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search people' });
  search.addEventListener('input', () => { friendQuery = search.value; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
  const recs = el('div', { id: 'recs' });
  v.replaceChildren(
    el('h2', { text: 'Add friends' }),
    el('p', { class: 'muted', text: `Your username: @${me.username} — share it so friends can find you.` }),
    search, el('div', { id: 'search-results' }), recs);
  paintResults();
  loadRecs(recs);

  if (incoming.length) {
    v.append(el('h3', { text: `Requests (${incoming.length})` }));
    for (const u of incoming) v.append(personRow(u,
      el('button', { class: 'btn primary', text: 'Accept', onclick: () => friendAction('accept', { from: u.username }, `You and ${u.name} are now friends`) }),
      el('button', { class: 'btn', text: '✕', 'aria-label': `Decline ${u.name}`, onclick: () => friendAction('decline', { user: u.username }) })));
  }
  if (outgoing.length) {
    v.append(el('h3', { text: 'Sent requests' }));
    for (const u of outgoing) v.append(personRow(u, el('button', { class: 'btn', text: 'Cancel', onclick: () => friendAction('cancel', { user: u.username }) })));
  }
  v.append(el('h3', { text: `My friends (${friends.length})` }));
  for (const u of friends) v.append(personRow(u,
    el('button', { class: 'btn', text: 'Chat', onclick: () => { showTab('chat'); openThread(u); } }),
    u.bot ? null : el('button', { class: 'btn danger', text: 'Remove', onclick: () => { if (confirm(`Remove ${u.name} as a friend? Your chat with them will be deleted.`)) friendAction('remove', { user: u.username }); } })));
}

// "People you may know": friends of your friends, ranked by mutual friends. Nothing is invented — it's empty until you have real connections.
async function loadRecs(box) {
  try {
    const { users } = await api('GET', '/recommendations');
    if (!box.isConnected) return;
    box.hidden = !!friendQuery.trim();
    box.replaceChildren(el('h3', { text: 'People you may know' }),
      ...(users.length ? users.map(u => personRow(u, addBtn(u)))
        : [el('p', { class: 'muted', text: 'No suggestions yet. Once your friends have friends, people you share mutual friends with will show up here.' })]));
  } catch { /* ignore */ }
}

async function runSearch() {
  const q = friendQuery.trim();
  const seq = ++searchSeq;
  const recs = $('#recs'); if (recs) recs.hidden = !!q;
  if (!q) { searchResults = []; paintResults(); return; }
  try {
    const d = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    searchResults = d.users;
  } catch (ex) { searchResults = []; toast(ex.message); }
  paintResults();
}
function paintResults() {
  const box = $('#search-results');
  if (!box) return;
  box.replaceChildren();
  const q = friendQuery.trim();
  if (!q) return;
  if (!searchResults.length) { box.append(el('p', { class: 'empty', text: `No one found for “${q}”.` })); return; }
  for (const u of searchResults) {
    const btn = u.rel === 'friend' ? el('span', { class: 'muted', text: 'Friends ✓' })
      : u.rel === 'outgoing' ? el('button', { class: 'btn', text: 'Pending — cancel', onclick: () => friendAction('cancel', { user: u.username }) })
      : u.rel === 'incoming' ? el('button', { class: 'btn primary', text: 'Accept', onclick: () => friendAction('accept', { from: u.username }, `You and ${u.name} are now friends`) })
      : addBtn(u);
    box.append(personRow(u, btn));
  }
}

function refreshSocial() {
  if (!me) return;
  setMeButton(); updateBadges();
  if (currentTab === 'friends') { const q = $('#view-friends input[type=search]'); const had = document.activeElement === q; renderFriends(); if (had) $('#view-friends input[type=search]').focus(); }
  if (currentTab === 'me') renderProfile($('#view-me'), me.username);
  refreshConvos().catch(() => {});
}

// Followers / following list for any user.
async function openUserList(kind, username) {
  const list = el('div', { class: 'ulist' }, el('p', { class: 'empty', text: 'Loading…' }));
  openModal([el('h2', { text: kind === 'followers' ? 'Followers' : 'Following' }), list, el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Close', onclick: closeModal }))]);
  try {
    const { users } = await api('GET', `/profile/${username}/${kind}`);
    list.replaceChildren(...(users.length ? users.map(u => {
      const isSelf = u.username === me.username;
      const btn = isSelf ? null : el('button', { class: `btn${u.following ? '' : ' primary'}`, text: u.following ? 'Following' : 'Follow', onclick: async e => {
        try { await api('POST', u.following ? '/unfollow' : '/follow', { user: u.username }); u.following = !u.following; e.target.textContent = u.following ? 'Following' : 'Follow'; e.target.classList.toggle('primary', !u.following); }
        catch (ex) { toast(ex.message); }
      } });
      return personRow(u, btn);            // tapping the name opens their profile (which also closes this list)
    }) : [el('p', { class: 'empty', text: kind === 'followers' ? 'No followers yet.' : 'Not following anyone yet.' })]));
  } catch (ex) { list.replaceChildren(el('p', { class: 'empty', text: ex.message })); }
}

/* =====================================================================
   Profile / account page — posts, reposts, friends, followers
   ===================================================================== */
async function renderProfile(box, username) {
  box.replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
  let d;
  try { d = await api('GET', `/profile/${username}`); }
  catch (ex) { box.replaceChildren(el('p', { class: 'empty', text: ex.message })); return; }
  const isMe = d.isMe, u = d.user;
  let kind = 'posts', loaded = [];
  const grid = el('div', { class: 'pgrid' });
  const stat = (n, label, fn) => el(fn ? 'button' : 'div', { class: 'stat', type: fn ? 'button' : null, onclick: fn }, el('b', { text: String(n) }), el('span', { text: label }));
  const again = () => renderProfile(box, username);

  const actions = el('div', { class: 'p-actions' });
  if (isMe) {
    actions.append(
      el('button', { class: 'btn primary', text: '🎨 Edit avatar', onclick: () => openAvatarEditor() }),
      el('button', { class: 'btn', text: '🛍 Dan Shop', onclick: openShop }),
      el('button', { class: 'btn', text: '⚙️ Settings', onclick: openSettings }));
  } else {
    const r = d.rel;
    const call = async (path, body, msg) => { try { await api('POST', path, body); if (msg) toast(msg); } catch (ex) { toast(ex.message); } await loadMe().catch(() => {}); refreshSocial(); again(); };
    actions.append(el('button', { class: `btn${r.following ? '' : ' primary'}`, text: r.following ? 'Following ✓' : (r.followedBy ? 'Follow back' : 'Follow'), onclick: () => call(r.following ? '/unfollow' : '/follow', { user: username }) }));
    if (r.friend) actions.append(el('button', { class: 'btn', text: '💬 Message', onclick: () => { const f = friends.find(x => x.username === username); if (f) { closeOverlays(); showTab('chat'); openThread(f); } } }));
    else if (r.incoming) actions.append(el('button', { class: 'btn primary', text: 'Accept friend request', onclick: () => call('/friends/accept', { from: username }, `You and ${u.name} are now friends`) }));
    else if (r.outgoing) actions.append(el('button', { class: 'btn', text: 'Request sent — cancel', onclick: () => call('/friends/cancel', { user: username }) }));
    else actions.append(el('button', { class: 'btn', text: '＋ Add friend', onclick: () => call('/friends/request', { to: username }, `Request sent to ${u.name}`) }));
  }

  const mutual = !isMe && (d.mutual
    ? el('p', { class: 'mutual', text: `👥 ${mutualText({ mutual: d.mutual, mutualNames: d.mutualNames })}` })
    : el('p', { class: 'mutual muted', text: 'No mutual friends yet' }));

  const chips = el('div', { class: 'tabs-scroll' }, ['posts', 'reposts'].map(k => el('button', { class: `chip${k === kind ? ' on' : ''}`, type: 'button', text: k === 'posts' ? `Posts (${d.stats.posts})` : `Reposts (${d.stats.reposts})`,
    onclick: e => { kind = k; $$('.chip', chips).forEach(c => c.classList.toggle('on', c === e.currentTarget)); loadGrid(); } })));

  async function loadGrid() {
    grid.replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
    try { loaded = (await api('GET', `/profile/${username}/posts?kind=${kind}`)).posts; } catch (ex) { grid.replaceChildren(el('p', { class: 'empty', text: ex.message })); return; }
    if (!loaded.length) {
      grid.replaceChildren(el('p', { class: 'empty', text: kind === 'posts'
        ? (isMe ? 'You haven’t posted yet — tap ＋ on the Watch tab to share your first video.' : 'No videos you can see yet.')
        : (isMe ? 'You haven’t reposted anything yet. Tap 🔁 on a public video to add it here.' : 'No reposts yet.') }));
      return;
    }
    grid.replaceChildren(...loaded.map((p, i) => el('button', { class: 'ptile', type: 'button', 'aria-label': `Open video: ${p.caption || 'untitled'}`, onclick: () => openViewer(loaded, i) },
      el('video', { src: `${p.url}#t=0.1`, muted: true, playsinline: true, preload: 'metadata' }),
      p.audio ? el('span', { class: 'ptag', text: '🎵' }) : null,
      p.mine ? el('span', { class: 'pvis', title: p.public ? 'Public' : 'Private', text: p.public ? '🌐' : '🔒' }) : null,
      el('span', { class: 'pcount', text: `❤️ ${p.likes}  👎 ${p.dislikes}` }),
      p.repostedBy ? el('span', { class: 'prepost', text: `🔁 ${p.by.name}` }) : null)));
  }

  box.replaceChildren(
    el('div', { class: 'p-head' }, avatarEl(u, 'xl'),
      el('h2', {}, nameNode(u)),
      el('p', { class: 'muted', text: `@${u.username} · joined ${new Date(d.joined).toLocaleDateString([], { month: 'short', year: 'numeric' })}` }),
      isMe ? el('p', { class: 'coin-line', text: `🪙 ${me.coins} Dan Coins` }) : mutual),
    el('div', { class: 'stats' },
      stat(d.stats.posts, 'Posts'), stat(d.stats.reposts, 'Reposts'), stat(d.stats.friends, 'Friends'),
      stat(d.stats.followers, 'Followers', () => openUserList('followers', username)),
      stat(d.stats.following, 'Following', () => openUserList('following', username))),
    actions,
    isMe && me.mod ? modPanel() : null,
    chips, grid);
  loadGrid();
}

// Only rendered for moderators (and the server re-checks the role on every mod action).
function modPanel() {
  return el('div', { class: 'mod-panel' },
    el('div', { class: 'mod-title', text: '🔨 Moderator tools' }),
    el('p', { class: 'muted small', text: 'You can remove any video you can see — tap the 🔨 on it in the feed or a profile. You can also claim Dan Coins here.' }),
    el('button', { class: 'btn primary', type: 'button', text: "🔨 Claim 100 🪙", onclick: async () => {
      try { const d = await api('POST', '/mod/coins'); gain(d); const line = $('#view-me .coin-line'); if (line) line.textContent = `🪙 ${d.coins} Dan Coins`; }
      catch (ex) { toast(ex.message); }
    } }));
}

// Someone else's profile (or your own) as a full-screen page on top of the app.
function openProfilePage(username) {
  if (username === me.username) { closeOverlays(); showTab('me'); return; }
  closeModal();
  const body = el('div', { class: 'page-body' });
  const node = el('div', { class: 'page' },
    el('div', { class: 'page-head' }, el('button', { class: 'btn', text: '←', 'aria-label': 'Back', onclick: () => node.remove() }), el('strong', { text: `@${username}` })),
    body);
  node.__reload = () => renderProfile(body, username);
  $('#overlay-root').append(node);
  renderProfile(body, username);
}

/* =====================================================================
   Watch — video feed with likes, dislikes, reposts and sound
   ===================================================================== */
let feedTab = 'friends', feedSeq = 0, feedCtl = null;
const FEED_TABS = [['friends', 'Friends'], ['following', 'Following'], ['discover', 'Discover']];
const FEED_EMPTY = {
  friends: 'No videos yet. Tap ＋ to post the first one, or add friends to see theirs.',
  following: 'Nothing here yet. Follow people from their profile to see their public videos and reposts.',
  discover: 'No public videos yet. Post one and share it with everyone!',
};

async function renderWatch() {
  const v = $('#view-watch');
  const seq = ++feedSeq;
  if (feedCtl) { feedCtl.dispose(); feedCtl = null; }
  const tabs = el('div', { class: 'feed-tabs' }, FEED_TABS.map(([id, label]) =>
    el('button', { class: id === feedTab ? 'active' : '', text: label, onclick: () => { feedTab = id; renderWatch(); } })));
  const holder = el('div', { class: 'feed' }, el('p', { class: 'empty', style: 'padding-top:30vh', text: 'Loading…' }));
  v.replaceChildren(tabs, holder);
  let posts;
  try { posts = (await api('GET', `/feed?tab=${feedTab}`)).posts; }
  catch (ex) { holder.replaceChildren(el('p', { class: 'empty', style: 'padding-top:30vh', text: ex.message })); return; }
  if (seq !== feedSeq) return;
  if (!posts.length) {
    holder.replaceChildren(el('div', { class: 'empty', style: 'padding-top:26vh' }, el('div', { class: 'big', text: '🎬' }), el('p', { text: FEED_EMPTY[feedTab] })));
    return;
  }
  feedCtl = makeFeed(posts);
  holder.replaceWith(feedCtl.node);
}

// A vertically snapping list of clips; only the clip on screen plays.
function makeFeed(posts) {
  const feed = el('div', { class: 'feed' });
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) { const fn = e.isIntersecting ? e.target.__start : e.target.__stop; if (fn) fn(); }
  }, { root: feed, threshold: 0.6 });
  for (const p of posts) { const c = clip(p); feed.append(c.node); observer.observe(c.video); }
  return {
    node: feed,
    scrollTo: i => { feed.scrollTop = i * feed.clientHeight; },
    dispose: () => { observer.disconnect(); $$('video, audio', feed).forEach(m => m.pause()); },
  };
}

function clip(post) {
  let reaction = post.reaction, reposted = post.reposted;
  const audio = post.audio ? el('audio', { src: post.audio, loop: true, preload: 'auto' }) : null;   // optional music / voice-over track
  const video = el('video', { src: post.url, loop: true, playsinline: true, preload: 'metadata' });
  video.muted = true;

  // Sound: every post has a sound button. A post's own track (if any) replaces the video's audio.
  const soundBtn = el('button', { class: 'sound-btn', type: 'button', 'aria-label': 'Sound' }, el('span', { class: 'big' }), el('span', { class: 'lbl' }));
  const hint = el('div', { class: 'hint' });
  const paintSound = (blocked = false) => {
    const on = soundOn() && !blocked;
    soundBtn.firstChild.textContent = on ? '🔊' : '🔇';
    soundBtn.lastChild.textContent = on ? 'Sound' : 'Muted';
    soundBtn.classList.toggle('on', on);
    hint.textContent = blocked ? '🔇 tap 🔊 for sound' : (audio ? '🎵 has music' : '');
    hint.hidden = !hint.textContent;
  };
  const applySound = () => { const m = !soundOn(); if (audio) { video.muted = true; audio.muted = m; } else video.muted = m; };
  const syncAudio = () => { if (audio) { const d = audio.duration; audio.currentTime = isFinite(d) && d > 0 ? video.currentTime % d : 0; } };
  const playAll = async () => {
    applySound();
    let blocked = false;
    try { await video.play(); } catch { video.muted = true; blocked = soundOn() && !audio; try { await video.play(); } catch { /* ignore */ } }
    if (audio) { syncAudio(); try { await audio.play(); } catch { audio.muted = true; blocked = soundOn(); } }
    paintSound(blocked);
  };
  video.__start = playAll;
  video.__stop = () => { video.pause(); if (audio) audio.pause(); };
  video.addEventListener('seeked', syncAudio);
  video.addEventListener('timeupdate', () => { if (audio && !audio.paused && Math.abs(audio.currentTime - (video.currentTime % (audio.duration || Infinity))) > .5) syncAudio(); });
  const toggleSound = () => { setSoundPref(!soundOn()); applySound(); paintSound(); if (soundOn()) { video.play().catch(() => {}); if (audio) audio.play().catch(() => {}); } };
  soundBtn.addEventListener('click', toggleSound);
  video.addEventListener('click', toggleSound);
  paintSound();

  // Like / dislike (mutually exclusive), repost, reply or delete.
  const count = (icon, n, label) => [el('span', { class: 'big', text: icon }), el('span', { class: 'n', text: String(n) })];
  const likeBtn = el('button', { type: 'button', 'aria-label': 'Like' });
  const dislikeBtn = el('button', { type: 'button', 'aria-label': 'Dislike' });
  const paintReactions = (likes, dislikes) => {
    likeBtn.replaceChildren(...count(reaction === 'like' ? '❤️' : '🤍', likes));
    dislikeBtn.replaceChildren(...count('👎', dislikes));
    likeBtn.classList.toggle('on', reaction === 'like'); dislikeBtn.classList.toggle('on', reaction === 'dislike');
  };
  paintReactions(post.likes, post.dislikes);
  const react = async r => {
    try { const d = await api('POST', `/posts/${post.id}/react`, { reaction: reaction === r ? null : r }); reaction = d.reaction; paintReactions(d.likes, d.dislikes); }
    catch (ex) { toast(ex.message); }
  };
  likeBtn.addEventListener('click', () => react('like'));
  dislikeBtn.addEventListener('click', () => react('dislike'));

  const repostBtn = el('button', { type: 'button', 'aria-label': 'Repost' });
  const paintRepost = n => { repostBtn.replaceChildren(...count('🔁', n)); repostBtn.classList.toggle('on', reposted); };
  paintRepost(post.reposts);
  repostBtn.addEventListener('click', async () => {
    if (post.mine) return toast('You can’t repost your own video');
    if (!post.public) return toast('Only public videos can be reposted');
    try { const d = await api('POST', `/posts/${post.id}/repost`); reposted = d.reposted; paintRepost(d.reposts); toast(reposted ? '🔁 Reposted to your profile' : 'Repost removed'); }
    catch (ex) { toast(ex.message); }
  });

  // Visibility: public (everyone) or private (friends only). The author can switch it at any time.
  const pubTag = el('span', { class: 'tag', text: 'PUBLIC' });
  const visBtn = el('button', { type: 'button', 'aria-label': 'Change who can see this post' }, el('span', { class: 'big' }), el('span', { class: 'n' }));
  const paintVis = () => { pubTag.hidden = !post.public; visBtn.firstChild.textContent = post.public ? '🌐' : '🔒'; visBtn.lastChild.textContent = post.public ? 'Public' : 'Private'; };
  paintVis();
  visBtn.addEventListener('click', async () => {
    try {
      const d = await api('POST', `/posts/${post.id}/visibility`, { public: !post.public });
      post.public = d.post.public; paintVis();
      toast(post.public ? '🌐 Public — anyone can watch and repost it' : '🔒 Private — only your friends can watch it (reposts removed)');
    } catch (ex) { toast(ex.message); }
  });
  const side = el('div', { class: 'side' }, likeBtn, dislikeBtn, repostBtn);
  const friend = friends.find(f => f.username === post.by.username);
  if (post.mine) side.append(visBtn, el('button', { type: 'button', 'aria-label': 'Delete post', onclick: () => deletePost(post.id) }, el('span', { class: 'big', text: '🗑️' }), el('span', { class: 'n', text: 'Delete' })));
  else side.append(el('button', { type: 'button', 'aria-label': `Reply to ${post.by.name}`, onclick: () => { if (friend) { closeOverlays(); showTab('chat'); openThread(friend); } else toast(`Add ${post.by.name} as a friend to reply`); } },
    el('span', { class: 'big', text: '💬' }), el('span', { class: 'n', text: 'Reply' })));
  if (me.mod && !post.mine) side.append(el('button', { type: 'button', 'aria-label': 'Remove post (moderator)', onclick: () => deletePost(post.id, true) }, el('span', { class: 'big', text: '🔨' }), el('span', { class: 'n', text: 'Remove' })));
  side.append(soundBtn);

  const node = el('article', { class: 'clip' }, video, audio, hint, el('div', { class: 'shade' }),
    el('div', { class: 'meta' },
      post.repostedBy ? el('div', { class: 'reposted', text: `🔁 ${post.repostedBy.username === me.username ? 'You' : post.repostedBy.name} reposted` }) : null,
      el('button', { class: 'who', type: 'button', onclick: () => openProfilePage(post.by.username) }, avatarEl(post.by, 'sm'), nameNode({ ...post.by, name: post.mine ? 'You' : post.by.name }), pubTag),
      el('div', { class: 'cap', text: post.caption })),
    side);
  return { node, video };
}

// Full-screen player for a list of videos (opened from profile grids).
function openViewer(posts, index) {
  const ctl = makeFeed(posts);
  const close = () => { ctl.dispose(); node.remove(); };
  const node = el('div', { class: 'viewer' }, ctl.node, el('button', { class: 'viewer-close', type: 'button', 'aria-label': 'Close video', text: '✕', onclick: close }));
  node.__close = close;
  $('#overlay-root').append(node);
  ctl.scrollTo(index);
}

async function deletePost(id, asMod = false) {
  if (!confirm(asMod ? 'Remove this video as a moderator? The author will be told a moderator removed it.' : 'Delete this video?')) return;
  try {
    await api('DELETE', `/posts/${id}`);
    $$('.viewer').forEach(n => n.__close());
    $$('.page').forEach(p => p.__reload && p.__reload());
    if (currentTab === 'me') renderProfile($('#view-me'), me.username); else if (currentTab === 'watch') renderWatch();
    if (asMod) toast('🔨 Video removed');
  } catch (ex) { toast(ex.message); }
}

function showNewPostsChip() {
  const tabs = $('.feed-tabs');
  if (!tabs || $('.new-chip')) return;
  tabs.after(el('button', { class: 'new-chip', text: '↻ New videos', onclick: renderWatch }));
}

const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', weba: 'audio/webm' };
const AUDIO_OK = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'];
function videoMime(blob) {
  const t = (blob.type || '').split(';')[0].toLowerCase();
  if (Object.values(VIDEO_MIME).includes(t)) return t;
  return VIDEO_MIME[(blob.name || '').split('.').pop().toLowerCase()] || '';
}
function audioMime(file) {
  const t = (file.type || '').split(';')[0].toLowerCase();
  if (AUDIO_OK.includes(t)) return t;
  return AUDIO_MIME[(file.name || '').split('.').pop().toLowerCase()] || '';
}
function uploadRaw(url, blob, mime, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('X-DC', '1');
    x.setRequestHeader('Content-Type', mime);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status === 401) sessionExpired();
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error((d && d.error) || 'Upload failed'));
    };
    x.onerror = () => reject(new Error('Network error while uploading'));
    x.send(blob);
  });
}

function openComposer() {
  let blob = null, audioFile = null, stream = null, rec = null, stopTimer = 0, previewUrl = '';
  const preview = el('video', { class: 'preview', playsinline: true, controls: true });
  preview.muted = true;
  const caption = el('input', { type: 'text', placeholder: 'Add a caption…', maxlength: '120', 'aria-label': 'Caption' });
  // Public = anyone can watch it on Discover and repost it. Private = friends only.
  let isPublic = false;
  const visNote = el('p', { class: 'muted small vis-note' });
  const visBtns = [[false, '🔒 Private', 'Friends only'], [true, '🌐 Public', 'Everyone']].map(([val, label, sub]) =>
    el('button', { class: 'seg-btn', type: 'button', role: 'radio', onclick: () => { isPublic = val; paintVis(); } }, el('b', { text: label }), el('span', { text: sub })));
  const paintVis = () => {
    visBtns.forEach((b, i) => { const on = (i === 1) === isPublic; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    visNote.textContent = isPublic ? 'Anyone on Danychat can watch this on Discover, and people can repost it to their profiles.' : 'Only your friends can watch this. You can change it later.';
  };
  const visRow = el('div', { class: 'vis' }, el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Who can see this post' }, visBtns), visNote);
  paintVis();
  const err = el('p', { class: 'error' });
  const postBtn = el('button', { class: 'btn primary grow', text: 'Post', disabled: true });
  const recBtn = el('button', { class: 'btn grow', type: 'button', text: '🔴 Record (15s)' });
  const file = el('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,video/*', hidden: true });
  const audioInput = el('input', { type: 'file', accept: 'audio/*', hidden: true, id: 'audio-input' });
  const audioLabel = el('span', { class: 'muted small', text: 'No sound track attached' });
  const audioClear = el('button', { class: 'btn', type: 'button', text: 'Remove', hidden: true, onclick: () => { audioFile = null; audioInput.value = ''; audioLabel.textContent = 'No sound track attached'; audioClear.hidden = true; } });

  const setBlob = b => {
    blob = b;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(b);
    preview.srcObject = null; preview.src = previewUrl; preview.muted = false; preview.controls = true; preview.loop = true;
    postBtn.disabled = false; err.textContent = '';
  };
  const stopStream = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; clearTimeout(stopTimer); };

  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (!videoMime(f)) { err.textContent = 'Please choose an MP4, WebM or MOV video.'; return; }
    if (f.size > 60 * 1024 * 1024) { err.textContent = 'That video is over 60 MB.'; return; }
    setBlob(f);
  });
  audioInput.addEventListener('change', () => {
    const f = audioInput.files[0];
    if (!f) return;
    if (!audioMime(f)) { err.textContent = 'Please choose an MP3, M4A, AAC, WAV, OGG or WebM audio file.'; return; }
    if (f.size > 15 * 1024 * 1024) { err.textContent = 'That audio file is over 15 MB.'; return; }
    audioFile = f; err.textContent = '';
    audioLabel.textContent = `🎵 ${f.name}`; audioClear.hidden = false;
  });
  recBtn.addEventListener('click', async () => {
    if (rec && rec.state === 'recording') { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { err.textContent = 'Recording isn’t supported here (it needs a secure connection) — choose a file instead.'; return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true }); }
    catch { err.textContent = 'Couldn’t access the camera. Check permissions or choose a file.'; return; }
    const chunks = [];
    preview.srcObject = stream; preview.controls = false; preview.muted = true; preview.play().catch(() => {});
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => { stopStream(); recBtn.textContent = '🔴 Re-record'; setBlob(new Blob(chunks, { type: (rec.mimeType || 'video/webm').split(';')[0] })); };
    rec.start();
    recBtn.textContent = '⏹ Stop';
    stopTimer = setTimeout(() => rec.state === 'recording' && rec.stop(), 15000);
  });
  postBtn.addEventListener('click', async () => {
    if (!blob) return;
    postBtn.disabled = true; err.textContent = '';
    try {
      const res = await uploadRaw('/api/posts', blob, videoMime(blob) || 'video/webm',
        { 'X-Caption': encodeURIComponent(caption.value.trim()), 'X-Public': isPublic ? '1' : '0' },
        p => { postBtn.textContent = `Uploading ${Math.round(p * 100)}%`; });
      if (audioFile) {
        postBtn.textContent = 'Uploading sound…';
        try { await uploadRaw(`/api/posts/${res.post.id}/audio`, audioFile, audioMime(audioFile), {}); }
        catch (ex) { toast(`Posted, but the sound track failed: ${ex.message}`); }
      }
      close(); feedTab = 'friends'; renderWatch(); gain(res); if (!res.earned) toast('Posted! 🎬');
    } catch (ex) { err.textContent = ex.message; postBtn.disabled = false; postBtn.textContent = 'Post'; }
  });
  const close = openModal([
    el('h2', { text: 'New post' }),
    el('p', { text: 'Record a clip or upload a video, and add music or a voice-over if you like.' }),
    preview, caption,
    el('div', { class: 'audio-row' }, el('button', { class: 'btn', type: 'button', text: '🎵 Add sound', onclick: () => audioInput.click() }), audioLabel, audioClear, audioInput),
    visRow,
    err,
    el('div', { class: 'actions' }, recBtn, el('button', { class: 'btn grow', type: 'button', text: '📁 Choose video', onclick: () => file.click() }), file),
    el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Cancel', onclick: () => closeModal() }), postBtn),
  ], { onClose: () => { if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); } stopStream(); if (previewUrl) URL.revokeObjectURL(previewUrl); } });
}

/* =====================================================================
   Games menu + friends leaderboards
   ===================================================================== */
let stopGameFn = null, myScores = {};
function stopGame() { if (stopGameFn) { const f = stopGameFn; stopGameFn = null; f(); } }
const fmtScore = (g, v) => `${v}${g.unit}`;

async function renderGames() {
  stopGame();
  const v = $('#view-games');
  const paint = () => v.replaceChildren(el('h2', { text: 'Games' }),
    el('div', { class: 'game-grid' }, GAMES.map(g => el('button', { class: 'game-card', onclick: () => startGame(g) },
      el('div', { class: 'big', text: g.emoji }), el('div', { class: 't', text: g.title }),
      el('div', { class: 's', text: myScores[g.id] != null ? `Your ${g.mode === 'sum' ? 'total' : 'best'}: ${fmtScore(g, myScores[g.id])}` : g.sub })))),
    el('p', { class: 'score-line', text: 'Scores are shared with your friends on each game’s leaderboard. Your first score in each game earns 5 🪙.' }));
  paint();
  try { myScores = (await api('GET', '/scores')).scores; if (currentTab === 'games' && !stopGameFn && $('.game-grid')) paint(); } catch { /* ignore */ }
}

function startGame(g) {
  const v = $('#view-games');
  const stage = el('div');
  const board = el('div', { class: 'board' });
  v.replaceChildren(
    el('div', { class: 'game-top' }, el('button', { class: 'btn', text: '← Games', onclick: renderGames }), el('strong', { text: `${g.emoji} ${g.title}` }), el('span')),
    stage, el('h3', { text: 'Friends leaderboard' }), board);
  const paintBoard = async () => {
    try {
      const rows = (await api('GET', `/scores/${g.id}`)).board;
      if (currentTab !== 'games' || !board.isConnected) return;
      board.replaceChildren(...(rows.length ? rows.map((r, i) => el('div', { class: 'row' }, el('span', { class: 'rank', text: `${i + 1}` }), avatarEl(r.user, 'sm'),
        el('div', { class: 'grow name' }, nameNode(r.user), r.user.username === me.username ? ' (you)' : ''), el('strong', { text: fmtScore(g, r.value) })))
        : [el('p', { class: 'empty', text: 'No scores yet — set the first one!' })]));
    } catch { /* ignore */ }
  };
  const ctx = {
    submit: async score => {
      try { const d = await api('POST', '/scores', { game: g.id, score }); myScores[g.id] = d.best; gain(d); paintBoard(); return d.best; }
      catch (ex) { toast(ex.message); }
    },
  };
  paintBoard();
  stopGameFn = g.run(stage, ctx) || null;
}

/* =====================================================================
   Calls — voice & video between friends (WebRTC)
   The server only relays the set-up messages; the audio/video itself goes
   straight between the two browsers. A public STUN server helps them find
   each other; without a TURN relay a few strict networks can't connect.
   ===================================================================== */
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let call = null;   // { id, peer, video, role, state, pc, local, remote, node, els, timer, secs, pendingIce }
let ring = null;

const callSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
const getMedia = video => navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false });
const stopStream = st => { if (st) st.getTracks().forEach(t => t.stop()); };
const sendSignal = data => { if (call) quiet(api('POST', `/calls/${call.id}/signal`, { data })); };
const fmtDuration = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function startRing() {                          // simple repeating beep; silently skipped if the browser blocks audio
  stopRing();
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 440; g.gain.value = .06; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + .4); };
    beep(); ring = { ac, iv: setInterval(beep, 1500) };
  } catch { ring = null; }
}
function stopRing() { if (ring) { clearInterval(ring.iv); ring.ac.close().catch(() => {}); ring = null; } }

async function startCall(user, video) {
  if (call) { toast('You’re already in a call'); return; }
  if (!callSupported()) { toast('Calling needs a modern browser on a secure connection (https or localhost).'); return; }
  let local;
  try { local = await getMedia(video); }
  catch { toast(video ? 'Couldn’t access your camera and microphone.' : 'Couldn’t access your microphone.'); return; }
  let id;
  try { id = (await api('POST', '/calls', { to: user.username, video })).call.id; }
  catch (ex) { stopStream(local); toast(ex.message); return; }
  call = { id, peer: user, video, role: 'caller', state: 'ringing', local, remote: null, pc: null, pendingIce: [], secs: 0, timer: 0 };
  showCallUI();
}

function onCallEvent(ev) {
  if (ev.type === 'call-invite') {
    if (call) { quiet(api('POST', `/calls/${ev.call.id}/decline`)); return; }          // already busy
    call = { id: ev.call.id, peer: ev.call.from, video: ev.call.video, role: 'callee', state: 'ringing', local: null, remote: null, pc: null, pendingIce: [], secs: 0, timer: 0 };
    showIncomingUI(); startRing();
    return;
  }
  if (!call || ev.id !== call.id) return;
  if (ev.type === 'call-accepted') beginAsCaller();
  else if (ev.type === 'call-signal') handleSignal(ev.data);
  else if (ev.type === 'call-ended') {
    const n = call.peer.name;
    finishCall({ declined: `${n} declined the call`, missed: `${n} didn’t answer`, cancelled: 'The call was cancelled', dropped: 'The call dropped', hangup: 'Call ended' }[ev.reason] || 'Call ended');
  }
}

function showIncomingUI() {
  const c = call;
  c.node = el('div', { class: 'call incoming', role: 'alertdialog', 'aria-label': `Incoming call from ${c.peer.name}` },
    el('div', { class: 'call-center' }, avatarEl(c.peer, 'xl'), el('h2', { text: c.peer.name }), el('div', { class: 'call-status', text: `Incoming ${c.video ? 'video' : 'voice'} call…` })),
    el('div', { class: 'call-controls' },
      el('button', { class: 'call-btn end', type: 'button', 'aria-label': 'Decline call', text: '✕', onclick: declineIncoming }),
      el('button', { class: 'call-btn accept', type: 'button', 'aria-label': 'Accept call', text: c.video ? '📹' : '📞', onclick: acceptIncoming })));
  $('#overlay-root').append(c.node);
}
function declineIncoming() {
  const c = call; if (!c) return;
  stopRing(); quiet(api('POST', `/calls/${c.id}/decline`)); c.node.remove(); call = null;
}
async function acceptIncoming() {
  const c = call; if (!c) return;
  stopRing();
  try { c.local = await getMedia(c.video); }
  catch { toast('Couldn’t access your microphone' + (c.video ? ' and camera.' : '.')); declineIncoming(); return; }
  if (!callSupported()) { toast('Calling isn’t supported in this browser.'); declineIncoming(); return; }
  c.state = 'connecting'; c.node.remove(); showCallUI();
  makePeer();                                                       // ready before the caller's offer arrives
  try { await api('POST', `/calls/${c.id}/accept`); } catch (ex) { finishCall(ex.message); }
}

function showCallUI() {
  const c = call;
  const remote = el('video', { class: 'remote', autoplay: true, playsinline: true });
  const local = el('video', { class: 'local', autoplay: true, playsinline: true, muted: true });
  local.muted = true;
  if (c.video) local.srcObject = c.local;
  const status = el('div', { class: 'call-status' });
  const toggle = (kind, btn, on, off, labelOn, labelOff) => () => {
    const tracks = kind === 'audio' ? c.local.getAudioTracks() : c.local.getVideoTracks();
    const enable = !(tracks[0] && tracks[0].enabled);
    tracks.forEach(t => { t.enabled = enable; });
    btn.textContent = enable ? on : off; btn.classList.toggle('off', !enable); btn.setAttribute('aria-label', enable ? labelOn : labelOff);
  };
  const muteBtn = el('button', { class: 'call-btn', type: 'button', 'aria-label': 'Mute microphone', text: '🎤' });
  muteBtn.addEventListener('click', toggle('audio', muteBtn, '🎤', '🔇', 'Mute microphone', 'Unmute microphone'));
  let camBtn = null;
  if (c.video) { camBtn = el('button', { class: 'call-btn', type: 'button', 'aria-label': 'Turn camera off', text: '📷' }); camBtn.addEventListener('click', toggle('video', camBtn, '📷', '🚫', 'Turn camera off', 'Turn camera on')); }
  c.node = el('div', { class: `call${c.video ? ' video' : ''}` }, remote,
    el('div', { class: 'call-center' }, avatarEl(c.peer, 'xl'), el('h2', { text: c.peer.name }), status),
    c.video ? local : null,
    el('div', { class: 'call-controls' }, muteBtn, camBtn, el('button', { class: 'call-btn end', type: 'button', 'aria-label': 'Hang up', text: '📞', onclick: hangUp })));
  c.els = { remote, local, status };
  $('#overlay-root').append(c.node);
  paintCallStatus();
}
function paintCallStatus() {
  const c = call; if (!c || !c.els) return;
  c.els.status.textContent = c.state === 'active' ? fmtDuration(c.secs) : c.state === 'ringing' ? `Calling ${c.peer.name}…` : 'Connecting…';
}

function makePeer() {
  const c = call, pc = new RTCPeerConnection(RTC_CONFIG);
  c.pc = pc;
  c.local.getTracks().forEach(t => pc.addTrack(t, c.local));
  pc.onicecandidate = e => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
  pc.ontrack = e => {
    c.remote = e.streams[0];
    c.els.remote.srcObject = c.remote;
    const p = c.els.remote.play && c.els.remote.play(); if (p && p.catch) p.catch(() => {});
    c.node.classList.add('live');
  };
  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    if (pc.connectionState === 'connected') markActive();
    else if (pc.connectionState === 'failed') { quiet(api('POST', `/calls/${c.id}/end`)); finishCall('The call couldn’t connect (a strict network may be blocking direct calls).'); }
  };
}
function markActive() {
  const c = call; if (!c || c.state === 'active') return;
  c.state = 'active'; c.secs = 0;
  c.timer = setInterval(() => { c.secs++; paintCallStatus(); }, 1000);
  paintCallStatus();
}
async function beginAsCaller() {
  const c = call; if (!c) return;
  c.state = 'connecting'; paintCallStatus(); makePeer();
  try { const offer = await c.pc.createOffer(); await c.pc.setLocalDescription(offer); sendSignal({ sdp: c.pc.localDescription }); }
  catch { hangUp(); toast('Couldn’t start the call.'); }
}
async function handleSignal(data) {
  const c = call; if (!c || !c.pc || !data) return;
  try {
    if (data.sdp) {
      await c.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') { const answer = await c.pc.createAnswer(); await c.pc.setLocalDescription(answer); sendSignal({ sdp: c.pc.localDescription }); }
      for (const cand of c.pendingIce.splice(0)) await c.pc.addIceCandidate(cand);
    } else if (data.candidate) {
      if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.candidate); else c.pendingIce.push(data.candidate);
    }
  } catch (e) { console.warn('call signalling', e); }
}

function hangUp() {
  const c = call; if (!c) return;
  quiet(api('POST', `/calls/${c.id}/end`));
  finishCall('Call ended');
}
function finishCall(message) {
  const c = call; if (!c) return;
  call = null;
  clearInterval(c.timer); stopRing(); stopStream(c.local);
  if (c.pc) { try { c.pc.close(); } catch { /* already closed */ } }
  if (c.node) c.node.remove();
  if (message) toast(message);
}
const endCallLocal = () => finishCall(null);

/* =====================================================================
   Boot
   ===================================================================== */
async function boot() {
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => { closeOverlays(); showTab(b.dataset.tab); }));
  $('#btn-post').addEventListener('click', openComposer);
  $('#btn-me').addEventListener('click', () => { if (me) { closeOverlays(); showTab('me'); } });
  $('#btn-coins').addEventListener('click', () => me && openShop());
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (me && t !== currentTab) showTab(t); });
  try { await loadMe(); enterApp(); }
  catch (ex) { showAuth(ex.status === 0 ? ex.message : ''); }
}
boot();
