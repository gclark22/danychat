'use strict';

/* =====================================================================
   Games. Each game is run(stage, ctx) and returns a cleanup function.
   ctx.submit(score) reports to the server (which keeps the best / adds
   wins) and refreshes the friends leaderboard. The computer opponent in
   the two-player games is DANY AI.
   ===================================================================== */

const GAMES = [
  { id: 'ttt',      emoji: '⭕', title: 'Tic-Tac-Toe',         sub: 'Beat DANY AI',        unit: ' wins',  mode: 'sum', run: gameTTT },
  { id: 'c4',       emoji: '🔴', title: 'Connect Four',        sub: 'Beat DANY AI',        unit: ' wins',  mode: 'sum', run: gameConnect4 },
  { id: 'rps',      emoji: '✌️', title: 'Rock Paper Scissors', sub: 'Beat DANY AI',        unit: ' wins',  mode: 'sum', run: gameRPS },
  { id: 'snake',    emoji: '🐍', title: 'Snake',               sub: 'Arrows / swipe',      unit: ' pts',   mode: 'max', run: gameSnake },
  { id: 'g2048',    emoji: '🔢', title: '2048',                sub: 'Merge the tiles',     unit: ' pts',   mode: 'max', run: game2048 },
  { id: 'flappy',   emoji: '🐤', title: 'Flappy Jump',         sub: 'Tap to flap',         unit: ' pts',   mode: 'max', run: gameFlappy },
  { id: 'whack',    emoji: '🔨', title: 'Whack-a-Mole',        sub: '30 seconds',          unit: ' pts',   mode: 'max', run: gameWhack },
  { id: 'memory',   emoji: '🧠', title: 'Memory Match',        sub: 'Fewest moves wins',   unit: ' moves', mode: 'min', run: gameMemory },
  { id: 'mines',    emoji: '💣', title: 'Minesweeper',         sub: 'Fastest clear wins',  unit: 's',      mode: 'min', run: gameMines },
  { id: 'reaction', emoji: '⚡', title: 'Reaction Time',       sub: 'Lowest ms wins',      unit: ' ms',    mode: 'min', run: gameReaction },
  { id: 'simon',    emoji: '🎵', title: 'Simon Says',          sub: 'Repeat the pattern',  unit: ' pts',   mode: 'max', run: gameSimon },
  { id: 'breakout', emoji: '🧱', title: 'Breakout',            sub: 'Smash the bricks',    unit: ' pts',   mode: 'max', run: gameBreakout },
];

const gameTop = (stage, ...kids) => stage.append(...kids);
const centered = (...kids) => el('div', { style: 'display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap' }, ...kids);
const newBtn = (text, fn) => el('button', { class: 'btn', type: 'button', text, onclick: fn });

/* ---------- Tic-Tac-Toe (vs DANY AI) ---------- */
function gameTTT(stage, ctx) {
  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const winnerOf = bd => {
    for (const [a, b, c] of LINES) if (bd[a] && bd[a] === bd[b] && bd[a] === bd[c]) return { w: bd[a], line: [a, b, c] };
    return bd.every(Boolean) ? { w: 'tie', line: [] } : null;
  };
  const minimax = (bd, turn) => {
    const r = winnerOf(bd);
    if (r) return r.w === 'O' ? 1 : r.w === 'X' ? -1 : 0;
    let best = turn === 'O' ? -2 : 2;
    for (let i = 0; i < 9; i++) if (!bd[i]) {
      bd[i] = turn;
      const s = minimax(bd, turn === 'O' ? 'X' : 'O');
      bd[i] = '';
      best = turn === 'O' ? Math.max(best, s) : Math.min(best, s);
    }
    return best;
  };
  let board, over, timer = 0, session = { w: 0, l: 0, d: 0 };
  const status = el('p', { class: 'game-status' });
  const tally = el('p', { class: 'score-line' });
  const cells = Array.from({ length: 9 }, (_, i) => el('button', { 'aria-label': `Cell ${i + 1}`, onclick: () => play(i) }));

  function draw(res) {
    cells.forEach((c, i) => { c.textContent = board[i]; c.className = board[i].toLowerCase(); if (res && res.line.includes(i)) c.classList.add('win'); });
    tally.textContent = `This session — you ${session.w} · DANY AI ${session.l} · draws ${session.d}`;
  }
  function finish(res) {
    over = true;
    if (res.w === 'X') { session.w++; status.textContent = 'You win! 🎉'; ctx.submit(1); }
    else if (res.w === 'O') { session.l++; status.textContent = 'DANY AI wins 🤖'; }
    else { session.d++; status.textContent = 'It’s a draw'; }
    draw(res);
  }
  function play(i) {
    if (over || board[i]) return;
    board[i] = 'X';
    let res = winnerOf(board);
    if (res) return finish(res);
    status.textContent = 'DANY AI is thinking…'; draw();
    timer = setTimeout(() => {
      const free = board.map((v, k) => v ? -1 : k).filter(k => k >= 0);
      let mv = free[0], best = -2;
      if (Math.random() < .25) mv = pick(free);            // DANY AI isn't perfect, so it can be beaten
      else for (const k of free) { board[k] = 'O'; const s = minimax(board, 'X'); board[k] = ''; if (s > best) { best = s; mv = k; } }
      board[mv] = 'O';
      res = winnerOf(board);
      if (res) return finish(res);
      status.textContent = 'Your turn (X)'; draw();
    }, 350);
  }
  function reset() { clearTimeout(timer); board = Array(9).fill(''); over = false; status.textContent = 'Your turn (X)'; draw(); }
  gameTop(stage, status, el('div', { class: 'ttt' }, cells), centered(newBtn('New game', reset)), tally);
  reset();
  return () => clearTimeout(timer);
}

/* ---------- Connect Four (vs DANY AI) ---------- */
function gameConnect4(stage, ctx) {
  const R = 6, C = 7;
  let b, over, busy, timer = 0;
  const status = el('p', { class: 'game-status' });
  const cells = Array.from({ length: R * C }, (_, i) => el('button', { class: 'c4cell', 'aria-label': `Column ${(i % C) + 1}`, onclick: () => play(i % C) }));
  const dropRow = c => { for (let r = R - 1; r >= 0; r--) if (!b[r][c]) return r; return -1; };
  const four = p => {
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const run = [];
      for (let k = 0; k < 4; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr >= R || cc < 0 || cc >= C || b[rr][cc] !== p) break;
        run.push(rr * C + cc);
      }
      if (run.length === 4) return run;
    }
    return null;
  };
  const full = () => b[0].every(Boolean);
  function heuristic() {
    let s = 0;
    for (let r = 0; r < R; r++) s += (b[r][3] === 2 ? 3 : b[r][3] === 1 ? -3 : 0);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let me = 0, you = 0, ok = true;
      for (let k = 0; k < 4; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr >= R || cc < 0 || cc >= C) { ok = false; break; }
        if (b[rr][cc] === 2) me++; else if (b[rr][cc] === 1) you++;
      }
      if (!ok || (me && you)) continue;
      if (me === 3) s += 5; else if (me === 2) s += 2;
      if (you === 3) s -= 6; else if (you === 2) s -= 2;
    }
    return s;
  }
  const ORDER = [3, 2, 4, 1, 5, 0, 6];
  function minimax(d, alpha, beta, maxing) {
    if (four(2)) return 100000 + d;
    if (four(1)) return -100000 - d;
    if (full()) return 0;
    if (d === 0) return heuristic();
    let best = maxing ? -Infinity : Infinity;
    for (const c of ORDER) {
      const r = dropRow(c);
      if (r < 0) continue;
      b[r][c] = maxing ? 2 : 1;
      const v = minimax(d - 1, alpha, beta, !maxing);
      b[r][c] = 0;
      if (maxing) { best = Math.max(best, v); alpha = Math.max(alpha, best); } else { best = Math.min(best, v); beta = Math.min(beta, best); }
      if (alpha >= beta) break;
    }
    return best;
  }
  function draw(win) {
    cells.forEach((el2, i) => { const v = b[Math.floor(i / C)][i % C]; el2.className = `c4cell${v ? ' p' + v : ''}${win && win.includes(i) ? ' win' : ''}`; });
  }
  function end(p) {
    over = true;
    const w = four(p);
    if (p === 1) { status.textContent = 'You win! 🎉'; ctx.submit(1); }
    else if (p === 2) status.textContent = 'DANY AI wins 🤖';
    else status.textContent = 'It’s a draw';
    draw(w);
  }
  function play(c) {
    if (over || busy) return;
    const r = dropRow(c);
    if (r < 0) return;
    b[r][c] = 1; draw();
    if (four(1)) return end(1);
    if (full()) return end(0);
    busy = true; status.textContent = 'DANY AI is thinking…';
    timer = setTimeout(() => {
      let best = -Infinity, col = ORDER.find(k => dropRow(k) >= 0);
      if (Math.random() < .15) col = pick([...Array(C).keys()].filter(k => dropRow(k) >= 0));   // not perfect, so it can be beaten
      else for (const k of ORDER) {
        const rr = dropRow(k);
        if (rr < 0) continue;
        b[rr][k] = 2;
        const v = minimax(3, -Infinity, Infinity, false);
        b[rr][k] = 0;
        if (v > best) { best = v; col = k; }
      }
      b[dropRow(col)][col] = 2; busy = false; draw();
      if (four(2)) return end(2);
      if (full()) return end(0);
      status.textContent = 'Your turn (pink)';
    }, 300);
  }
  function reset() { clearTimeout(timer); b = Array.from({ length: R }, () => Array(C).fill(0)); over = false; busy = false; status.textContent = 'Your turn (pink) — tap a column'; draw(); }
  gameTop(stage, status, el('div', { class: 'c4' }, cells), centered(newBtn('New game', reset)));
  reset();
  return () => clearTimeout(timer);
}

/* ---------- Rock Paper Scissors (vs DANY AI) ---------- */
function gameRPS(stage, ctx) {
  const M = [['✊', 'Rock'], ['✋', 'Paper'], ['✌️', 'Scissors']];
  let w = 0, l = 0, d = 0;
  const result = el('p', { class: 'game-status', text: 'Pick one!' });
  const tally = el('p', { class: 'score-line' });
  const show = () => { tally.textContent = `This session — you ${w} · DANY AI ${l} · draws ${d}`; };
  const buttons = M.map(([e, name], i) => el('button', { 'aria-label': name, text: e, onclick: () => {
    const ai = rand(3), r = (i - ai + 3) % 3;
    if (r === 1) { w++; ctx.submit(1); } else if (r === 2) l++; else d++;
    result.textContent = `You ${e} vs DANY AI ${M[ai][0]} — ${r === 1 ? 'you win! 🎉' : r === 2 ? 'DANY AI wins 🤖' : 'draw'}`;
    show();
  } }));
  gameTop(stage, result, el('div', { class: 'rps' }, buttons), tally);
  show();
  return () => {};
}

/* ---------- Snake ---------- */
function gameSnake(stage, ctx) {
  const N = 20, C = 16;
  const cv = el('canvas', { width: String(N * C), height: String(N * C), 'aria-label': 'Snake game board' });
  const g = cv.getContext('2d');
  const status = el('p', { class: 'game-status' });
  let snake, dir, next, food, points, timer = 0, alive;

  const placeFood = () => { do { food = { x: rand(N), y: rand(N) }; } while (snake.some(s => s.x === food.x && s.y === food.y)); };
  function reset() {
    clearInterval(timer); timer = 0;
    snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    dir = next = { x: 1, y: 0 }; points = 0; alive = true;
    placeFood(); draw();
    status.textContent = 'Press an arrow key, swipe, or use the pad to start';
  }
  function draw() {
    g.fillStyle = '#120e24'; g.fillRect(0, 0, N * C, N * C);
    g.fillStyle = '#ff4d8d'; g.beginPath(); g.arc(food.x * C + C / 2, food.y * C + C / 2, C / 2 - 2, 0, 7); g.fill();
    snake.forEach((s, i) => { g.fillStyle = i ? '#8b5cf6' : '#ffd23f'; g.fillRect(s.x * C + 1, s.y * C + 1, C - 2, C - 2); });
  }
  function step() {
    dir = next;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const ate = head.x === food.x && head.y === food.y;
    const body = ate ? snake : snake.slice(0, -1);
    if (head.x < 0 || head.y < 0 || head.x >= N || head.y >= N || body.some(s => s.x === head.x && s.y === head.y)) {
      clearInterval(timer); timer = 0; alive = false;
      status.textContent = `Game over — score ${points}`;
      if (points > 0) ctx.submit(points);
      return;
    }
    snake.unshift(head);
    if (ate) { points++; status.textContent = `Score: ${points}`; placeFood(); } else snake.pop();
    draw();
  }
  function turn(dx, dy) {
    if (!alive || (dx === -dir.x && dy === -dir.y)) return;
    next = { x: dx, y: dy };
    if (!timer) { status.textContent = `Score: ${points}`; timer = setInterval(step, 110); }
  }
  const KEYS = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const onKey = e => { const k = KEYS[e.key]; if (k) { e.preventDefault(); turn(...k); } };
  document.addEventListener('keydown', onKey);
  swipe(cv, turn);
  const pad = (cls, label, dx, dy) => el('button', { class: cls, text: label, 'aria-label': `Move ${cls}`, onclick: () => turn(dx, dy) });
  gameTop(stage, status, el('div', { class: 'snake-wrap' }, cv,
    el('div', { class: 'dpad' }, pad('u', '▲', 0, -1), pad('l', '◀', -1, 0), pad('d', '▼', 0, 1), pad('r', '▶', 1, 0)),
    newBtn('Restart', reset)));
  reset();
  return () => { clearInterval(timer); document.removeEventListener('keydown', onKey); };
}

// Calls turn(dx, dy) for a swipe on `node` (used by Snake and 2048).
function swipe(node, turn) {
  let sx = 0, sy = 0;
  node.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  node.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    Math.abs(dx) > Math.abs(dy) ? turn(Math.sign(dx), 0) : turn(0, Math.sign(dy));
  }, { passive: true });
}

/* ---------- 2048 ---------- */
function game2048(stage, ctx) {
  const N = 4;
  let g, score, over, submitted = 0;
  const status = el('p', { class: 'game-status' });
  const board = el('div', { class: 'g2048' });
  const T = m => m[0].map((_, c) => m.map(r => r[c]));
  const Rv = m => m.map(r => [...r].reverse());
  const slideRow = row => {
    const a = row.filter(Boolean); let gain = 0;
    for (let i = 0; i < a.length - 1; i++) if (a[i] === a[i + 1]) { a[i] *= 2; gain += a[i]; a.splice(i + 1, 1); }
    while (a.length < N) a.push(0);
    return { row: a, gain };
  };
  function slide(dir) {                                      // 0 left · 1 up · 2 right · 3 down
    let m = g.map(r => [...r]), gain = 0;
    if (dir === 1) m = T(m); else if (dir === 2) m = Rv(m); else if (dir === 3) m = Rv(T(m));
    m = m.map(r => { const s = slideRow(r); gain += s.gain; return s.row; });
    if (dir === 1) m = T(m); else if (dir === 2) m = Rv(m); else if (dir === 3) m = T(Rv(m));
    return { m, gain };
  }
  const spawn = () => {
    const e = [];
    g.forEach((row, r) => row.forEach((v, c) => { if (!v) e.push([r, c]); }));
    if (e.length) { const [r, c] = pick(e); g[r][c] = Math.random() < .9 ? 2 : 4; }
  };
  const flush = () => { if (score > submitted) { submitted = score; ctx.submit(score); } };
  function draw() {
    board.replaceChildren(...g.flat().map(v => el('div', {
      class: 'tile', text: v ? String(v) : '',
      style: v ? `background:hsl(${(Math.log2(v) * 38 + 250) % 360} 75% ${Math.max(28, 62 - Math.log2(v) * 2.5)}%);color:#fff;font-size:${v > 999 ? 'clamp(14px,4.5vw,20px)' : v > 99 ? 'clamp(16px,5.2vw,24px)' : ''}` : '',
    })));
    status.textContent = over ? `Game over — score ${score}` : `Score: ${score}`;
  }
  function move(dir) {
    if (over) return;
    const { m, gain } = slide(dir);
    if (JSON.stringify(m) === JSON.stringify(g)) return;
    g = m; score += gain; spawn();
    if (![0, 1, 2, 3].some(d => JSON.stringify(slide(d).m) !== JSON.stringify(g))) { over = true; flush(); }
    draw();
  }
  function reset() { flush(); g = Array.from({ length: N }, () => Array(N).fill(0)); score = 0; submitted = 0; over = false; spawn(); spawn(); draw(); }
  const KEYS = { ArrowLeft: 0, a: 0, ArrowUp: 1, w: 1, ArrowRight: 2, d: 2, ArrowDown: 3, s: 3 };
  const onKey = e => { if (e.key in KEYS) { e.preventDefault(); move(KEYS[e.key]); } };
  document.addEventListener('keydown', onKey);
  swipe(board, (dx, dy) => move(dx ? (dx < 0 ? 0 : 2) : (dy < 0 ? 1 : 3)));
  gameTop(stage, status, board, centered(newBtn('New game', reset)), el('p', { class: 'score-line', text: 'Arrow keys or swipe. Your score is saved when the game ends or you start a new one.' }));
  g = null; score = 0; reset();
  return () => { flush(); document.removeEventListener('keydown', onKey); };
}

/* ---------- Flappy Jump ---------- */
function gameFlappy(stage, ctx) {
  const W = 320, H = 480, PW = 52, GAP = 132, G = 1500, FLAP = -430, SPEED = 150, BX = 80, BR = 12;
  const cv = el('canvas', { class: 'flappy', width: String(W), height: String(H), 'aria-label': 'Flappy game board' });
  const g = cv.getContext('2d');
  let bird, pipes, score, state, last = 0, spawnT = 0, raf = 0;
  function reset() { bird = { y: H / 2, v: 0 }; pipes = []; score = 0; state = 'ready'; spawnT = 0; }
  function flap() {
    if (state === 'over') { if (performance.now() - overAt > 400) reset(); return; }
    if (state === 'ready') state = 'play';
    bird.v = FLAP;
  }
  let overAt = 0;
  function die() { state = 'over'; overAt = performance.now(); if (score > 0) ctx.submit(score); }
  function update(dt) {
    bird.v += G * dt; bird.y += bird.v * dt;
    spawnT -= dt;
    if (spawnT <= 0) { pipes.push({ x: W, gapY: 90 + rand(H - 180 - GAP), passed: false }); spawnT = 1.5; }
    for (const p of pipes) {
      p.x -= SPEED * dt;
      if (!p.passed && p.x + PW < BX) { p.passed = true; score++; }
      const hitX = BX + BR > p.x && BX - BR < p.x + PW;
      if (hitX && (bird.y - BR < p.gapY || bird.y + BR > p.gapY + GAP)) die();
    }
    pipes = pipes.filter(p => p.x > -PW);
    if (bird.y + BR > H - 24 || bird.y - BR < 0) die();
  }
  function draw() {
    const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#2a2150'); sky.addColorStop(1, '#ff9ec4');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#3ddc97';
    for (const p of pipes) { g.fillRect(p.x, 0, PW, p.gapY); g.fillRect(p.x, p.gapY + GAP, PW, H); g.fillStyle = '#28a874'; g.fillRect(p.x - 3, p.gapY - 14, PW + 6, 14); g.fillRect(p.x - 3, p.gapY + GAP, PW + 6, 14); g.fillStyle = '#3ddc97'; }
    g.fillStyle = '#5a3825'; g.fillRect(0, H - 24, W, 24);
    g.save(); g.translate(BX, bird.y); g.rotate(Math.max(-.5, Math.min(1, bird.v / 600)));
    g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(0, 0, BR, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(4, -3, 4, 0, 7); g.fill(); g.fillStyle = '#2b2233'; g.beginPath(); g.arc(5, -3, 1.8, 0, 7); g.fill();
    g.fillStyle = '#ff7a3d'; g.beginPath(); g.moveTo(9, 1); g.lineTo(18, 4); g.lineTo(9, 7); g.fill();
    g.restore();
    g.fillStyle = '#fff'; g.font = '700 34px system-ui'; g.textAlign = 'center'; g.fillText(String(score), W / 2, 56);
    if (state !== 'play') { g.font = '700 18px system-ui'; g.fillText(state === 'ready' ? 'Tap / Space to flap' : `Game over — ${score}. Tap to retry`, W / 2, H / 2 + 60); }
  }
  function loop(t) {
    const dt = Math.min((t - last) / 1000, .04); last = t;
    if (state === 'play') update(dt);
    draw(); raf = requestAnimationFrame(loop);
  }
  const onKey = e => { if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); flap(); } };
  document.addEventListener('keydown', onKey);
  cv.addEventListener('pointerdown', e => { e.preventDefault(); flap(); });
  gameTop(stage, el('p', { class: 'game-status', text: 'Fly through the gaps' }), cv);
  reset(); raf = requestAnimationFrame(t => { last = t; loop(t); });
  return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); };
}

/* ---------- Whack-a-Mole ---------- */
function gameWhack(stage, ctx) {
  const status = el('p', { class: 'game-status', text: 'Whack the moles! 30 seconds' });
  let holes, score = 0, time = 0, active = -1, tick = 0, spawn = 0, running = false;
  holes = Array.from({ length: 9 }, (_, i) => el('button', { class: 'hole', 'aria-label': `Hole ${i + 1}`, onclick: () => hit(i) }));
  const show = i => { holes.forEach((h, k) => { h.textContent = k === i ? '🐹' : ''; }); active = i; };
  function hit(i) {
    if (!running || i !== active) return;
    score++; show(-1); status.textContent = `Score ${score} · ${time}s left`;
  }
  function pop() {
    if (!running) return;
    show(rand(9));
    spawn = setTimeout(() => { show(-1); spawn = setTimeout(pop, 150 + rand(250)); }, Math.max(380, 800 - score * 12));
  }
  function stop() { clearInterval(tick); clearTimeout(spawn); running = false; show(-1); }
  function start() {
    stop(); score = 0; time = 30; running = true; status.textContent = `Score 0 · 30s left`;
    tick = setInterval(() => {
      time--; status.textContent = `Score ${score} · ${time}s left`;
      if (time <= 0) { stop(); status.textContent = `Time! You whacked ${score} 🎉`; if (score > 0) ctx.submit(score); }
    }, 1000);
    pop();
  }
  gameTop(stage, status, el('div', { class: 'holes' }, holes), centered(newBtn('Start', start)));
  return stop;
}

/* ---------- Memory Match ---------- */
function gameMemory(stage, ctx) {
  const faces = ['🍕', '🚀', '🎧', '🐙', '🌈', '🔥', '👾', '🍩'];
  let deck, first, lock, moves, matched, timer = 0;
  const status = el('p', { class: 'game-status' });
  const board = el('div', { class: 'memory' });
  function reset() {
    clearTimeout(timer);
    deck = shuffle([...faces, ...faces]); first = null; lock = false; moves = 0; matched = 0;
    status.textContent = 'Moves: 0';
    board.replaceChildren(...deck.map((f, i) => el('button', { class: 'card', 'aria-label': 'Hidden card', text: '?', onclick: e => flip(i, e.currentTarget) })));
  }
  function flip(i, card) {
    if (lock || card.classList.contains('up') || card.classList.contains('done')) return;
    card.classList.add('up'); card.textContent = deck[i];
    if (!first) { first = { i, card }; return; }
    moves++; status.textContent = `Moves: ${moves}`;
    const a = first; first = null;
    if (deck[a.i] === deck[i]) {
      [a.card, card].forEach(c => { c.classList.remove('up'); c.classList.add('done'); });
      if (++matched === faces.length) { status.textContent = `Done in ${moves} moves 🎉`; ctx.submit(moves); }
    } else {
      lock = true;
      timer = setTimeout(() => { [a.card, card].forEach(c => { c.classList.remove('up'); c.textContent = '?'; }); lock = false; }, 800);
    }
  }
  gameTop(stage, status, board, centered(newBtn('Shuffle & restart', reset)));
  reset();
  return () => clearTimeout(timer);
}

/* ---------- Minesweeper ---------- */
function gameMines(stage, ctx) {
  const W = 9, H = 9, M = 10;
  let cells, started, over, opened, secs, timer = 0, flagMode = false, flagged;
  const status = el('p', { class: 'game-status' });
  const grid = el('div', { class: 'mines' });
  const flagBtn = el('button', { class: 'btn', type: 'button', text: '🚩 Flag mode: off', onclick: () => { flagMode = !flagMode; flagBtn.textContent = `🚩 Flag mode: ${flagMode ? 'on' : 'off'}`; } });
  const btns = Array.from({ length: W * H }, (_, i) => {
    const b = el('button', { class: 'mcell', 'aria-label': `Cell ${i + 1}`, onclick: () => click(i) });
    b.addEventListener('contextmenu', e => { e.preventDefault(); flag(i); });
    return b;
  });
  grid.append(...btns);
  const nbrs = i => {
    const r = Math.floor(i / W), c = i % W, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && rr < H && cc >= 0 && cc < W) out.push(rr * W + cc);
    }
    return out;
  };
  function reset() {
    clearInterval(timer); timer = 0;
    cells = Array.from({ length: W * H }, () => ({ mine: false, n: 0, open: false, flag: false }));
    started = false; over = false; opened = 0; secs = 0; flagged = 0;
    status.textContent = `💣 ${M} · ⏱ 0s — tap a cell`; draw();
  }
  function place(safe) {
    const banned = new Set([safe, ...nbrs(safe)]);
    const spots = shuffle([...cells.keys()].filter(i => !banned.has(i))).slice(0, M);
    spots.forEach(i => { cells[i].mine = true; });
    cells.forEach((c, i) => { c.n = nbrs(i).filter(k => cells[k].mine).length; });
  }
  function draw() {
    btns.forEach((b, i) => {
      const c = cells[i];
      b.className = `mcell${c.open ? ' open' : ''}${c.open && c.mine ? ' boom' : ''}`;
      b.textContent = c.flag ? '🚩' : c.open ? (c.mine ? '💥' : c.n || '') : '';
      b.dataset.n = c.open && !c.mine && c.n ? String(c.n) : '';
    });
  }
  const setStatus = () => { status.textContent = `💣 ${M - flagged} · ⏱ ${secs}s`; };
  function click(i) {
    if (over) return;
    if (flagMode) return flag(i);
    const c = cells[i];
    if (c.flag || c.open) return;
    if (!started) { started = true; place(i); timer = setInterval(() => { secs++; setStatus(); }, 1000); }
    if (c.mine) {                                                // lose: reveal every mine
      over = true; clearInterval(timer);
      cells.forEach(x => { if (x.mine) x.open = true; });
      status.textContent = 'Boom! 💥 Try again'; return draw();
    }
    const stack = [i];
    while (stack.length) {
      const k = stack.pop(), x = cells[k];
      if (x.open || x.flag) continue;
      x.open = true; opened++;
      if (!x.n) stack.push(...nbrs(k));
    }
    if (opened === W * H - M) { over = true; clearInterval(timer); status.textContent = `Cleared in ${secs}s 🎉`; ctx.submit(Math.max(1, secs)); }
    else setStatus();
    draw();
  }
  function flag(i) {
    const c = cells[i];
    if (over || c.open) return;
    c.flag = !c.flag; flagged += c.flag ? 1 : -1;
    setStatus(); draw();
  }
  gameTop(stage, status, grid, centered(flagBtn, newBtn('New game', reset)), el('p', { class: 'score-line', text: 'Tap to reveal · right-click or use Flag mode to flag' }));
  reset();
  return () => clearInterval(timer);
}

/* ---------- Reaction Time ---------- */
function gameReaction(stage, ctx) {
  let state = 'idle', t0 = 0, timer = 0, best = null;
  const pad = el('button', { class: 'react idle', text: 'Click to start' });
  const info = el('p', { class: 'score-line' });
  const set = (cls, text) => { pad.className = `react ${cls}`; pad.textContent = text; };
  pad.addEventListener('pointerdown', () => {
    if (state === 'idle' || state === 'done') {
      state = 'wait'; set('wait', 'Wait for green…');
      timer = setTimeout(() => { state = 'go'; t0 = performance.now(); set('go', 'CLICK!'); }, 1200 + Math.random() * 2800);
    } else if (state === 'wait') {
      clearTimeout(timer); state = 'done'; set('idle', 'Too soon! Click to try again');
    } else if (state === 'go') {
      const ms = Math.round(performance.now() - t0);
      state = 'done'; set('idle', `${ms} ms — click to go again`);
      if (best == null || ms < best) best = ms;
      info.textContent = `Best this session: ${best} ms`;
      ctx.submit(ms);
    }
  });
  gameTop(stage, el('p', { class: 'game-status', text: 'Click as soon as it turns green' }), pad, info);
  return () => clearTimeout(timer);
}

/* ---------- Simon Says ---------- */
function gameSimon(stage, ctx) {
  const COLORS = [['#3ddc97', '#1d7a55'], ['#ff4d8d', '#8a2450'], ['#ffd23f', '#8a7010'], ['#5b8cff', '#2a4a9a']];   // [lit, dim]
  const FREQ = [261.6, 329.6, 392, 523.3];
  let seq = [], input = 0, state = 'idle', timers = [], audio = null;
  const status = el('p', { class: 'game-status', text: 'Press Start, watch the pattern, then repeat it' });
  const pads = COLORS.map((c, i) => el('button', { class: 'simon-pad', 'aria-label': `Pad ${i + 1}`, style: `background:${c[1]}`, onclick: () => press(i) }));
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  function beep(i) {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = FREQ[i]; g.gain.value = .08; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + .22);
    } catch { /* audio not available — the flashes still work */ }
  }
  function flash(i, ms = 340) {
    pads[i].style.background = COLORS[i][0]; pads[i].classList.add('lit'); beep(i);
    later(() => { pads[i].style.background = COLORS[i][1]; pads[i].classList.remove('lit'); }, ms);
  }
  function playback() {
    state = 'show'; status.textContent = `Round ${seq.length} — watch…`;
    const gap = Math.max(320, 650 - seq.length * 18);
    seq.forEach((p, k) => later(() => flash(p), 600 + k * gap));
    later(() => { state = 'input'; input = 0; status.textContent = `Round ${seq.length} — your turn`; }, 600 + seq.length * gap);
  }
  function next() { seq.push(rand(4)); playback(); }
  function press(i) {
    if (state !== 'input') return;
    flash(i, 200);
    if (seq[input] !== i) {
      state = 'over';
      const score = seq.length - 1;                                 // rounds fully completed
      status.textContent = `Wrong pad! You completed ${score} round${score === 1 ? '' : 's'}.`;
      if (score > 0) ctx.submit(score);
      return;
    }
    if (++input === seq.length) { state = 'show'; status.textContent = 'Nice! 🎉'; later(next, 800); }
  }
  function start() { timers.forEach(clearTimeout); timers = []; seq = []; next(); }
  gameTop(stage, status, el('div', { class: 'simon' }, pads), centered(newBtn('Start', start)));
  return () => { timers.forEach(clearTimeout); if (audio) audio.close().catch(() => {}); };
}

/* ---------- Breakout ---------- */
function gameBreakout(stage, ctx) {
  const W = 320, H = 440, PW = 62, PH = 10, BR = 6, COLS = 8, ROWS = 5, BW = W / COLS, BH = 16, TOP = 48;
  const cv = el('canvas', { class: 'flappy', width: String(W), height: String(H), 'aria-label': 'Breakout game board' });
  const g = cv.getContext('2d');
  let px, ball, bricks, score, lives, level, state, raf = 0, last = 0, submitted;
  const newBricks = () => Array.from({ length: ROWS * COLS }, (_, i) => ({ r: Math.floor(i / COLS), c: i % COLS, alive: true }));
  const speed = () => 230 + level * 25;
  function serve() { ball = { x: px + PW / 2, y: H - 40 - BR, vx: 0, vy: 0 }; state = 'ready'; }
  function reset() { px = W / 2 - PW / 2; bricks = newBricks(); score = 0; lives = 3; level = 1; submitted = false; serve(); }
  function launch() {
    if (state === 'ready') { const a = Math.random() * .6 - .3; ball.vx = speed() * Math.sin(a); ball.vy = -speed() * Math.cos(a); state = 'play'; }
    else if (state === 'over') reset();
  }
  function flush() { if (score > 0 && !submitted) { submitted = true; ctx.submit(score); } }
  function update(dt) {
    if (state === 'ready') { ball.x = px + PW / 2; return; }
    if (state !== 'play') return;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x < BR) { ball.x = BR; ball.vx = Math.abs(ball.vx); }
    if (ball.x > W - BR) { ball.x = W - BR; ball.vx = -Math.abs(ball.vx); }
    if (ball.y < BR) { ball.y = BR; ball.vy = Math.abs(ball.vy); }
    const py = H - 30;
    if (ball.vy > 0 && ball.y + BR >= py && ball.y + BR <= py + PH + 8 && ball.x >= px - BR && ball.x <= px + PW + BR) {   // paddle: aim with where it lands
      const sp = Math.hypot(ball.vx, ball.vy), off = (ball.x - (px + PW / 2)) / (PW / 2);
      ball.vx = off * sp * .8; ball.vy = -Math.sqrt(sp * sp - ball.vx * ball.vx); ball.y = py - BR;
    }
    for (const b of bricks) {
      if (!b.alive) continue;
      const bx = b.c * BW, by = TOP + b.r * BH;
      if (ball.x + BR > bx && ball.x - BR < bx + BW - 2 && ball.y + BR > by && ball.y - BR < by + BH - 2) {
        b.alive = false; score += 10;
        const ox = Math.min(ball.x + BR - bx, bx + BW - (ball.x - BR)), oy = Math.min(ball.y + BR - by, by + BH - (ball.y - BR));
        if (ox < oy) ball.vx = -ball.vx; else ball.vy = -ball.vy;
        break;
      }
    }
    if (bricks.every(b => !b.alive)) { level++; bricks = newBricks(); serve(); }
    if (ball.y > H + BR) { lives--; if (lives <= 0) { state = 'over'; flush(); } else serve(); }
  }
  function draw() {
    g.fillStyle = '#120e24'; g.fillRect(0, 0, W, H);
    for (const b of bricks) if (b.alive) { g.fillStyle = `hsl(${330 - b.r * 55} 80% 60%)`; g.fillRect(b.c * BW + 1, TOP + b.r * BH + 1, BW - 2, BH - 2); }
    g.fillStyle = '#ffd23f'; g.fillRect(px, H - 30, PW, PH);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(ball.x, ball.y, BR, 0, 7); g.fill();
    g.font = '700 14px system-ui'; g.textAlign = 'left'; g.fillText(`Score ${score}`, 8, 22); g.textAlign = 'right'; g.fillText(`Lives ${'♥'.repeat(Math.max(0, lives))}  ·  Lv ${level}`, W - 8, 22);
    if (state !== 'play') { g.textAlign = 'center'; g.font = '700 18px system-ui'; g.fillText(state === 'ready' ? 'Tap / Space to launch' : `Game over — ${score}. Tap to retry`, W / 2, H / 2 + 40); }
  }
  function loop(t) { const dt = Math.min((t - last) / 1000, .04); last = t; update(dt); draw(); raf = requestAnimationFrame(loop); }
  const move = clientX => { const r = cv.getBoundingClientRect(); px = Math.max(0, Math.min(W - PW, (clientX - r.left) / (r.width || W) * W - PW / 2)); };
  const onKey = e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); px = Math.max(0, px - 26); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); px = Math.min(W - PW, px + 26); }
    else if (e.key === ' ') { e.preventDefault(); launch(); }
  };
  document.addEventListener('keydown', onKey);
  cv.addEventListener('pointermove', e => move(e.clientX));
  cv.addEventListener('pointerdown', e => { move(e.clientX); launch(); });
  gameTop(stage, el('p', { class: 'game-status', text: 'Move the paddle with your mouse, finger or ← →' }), cv);
  reset(); raf = requestAnimationFrame(t => { last = t; loop(t); });
  return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); flush(); };
}
