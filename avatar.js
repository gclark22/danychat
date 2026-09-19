'use strict';

/* =====================================================================
   Avatars — a small Bitmoji-style character creator.
   An avatar is just a bag of integers (see DEFAULT_AVATAR). Each number
   indexes into a palette or a style list below, so the server only ever
   stores/validates numbers and the drawing code here can never be fed
   arbitrary markup.
   ===================================================================== */

const AV = {
  skin: [['#ffdcbf', '#efc2a0'], ['#f5c6a0', '#deaa86'], ['#e0a878', '#c78d5e'], ['#c68642', '#a86e30'], ['#8d5524', '#733f16'], ['#5c3a21', '#452712']],
  hairColor: ['#2b1d16', '#5a3825', '#a0522d', '#d9a441', '#f2d16b', '#c0392b', '#8e44ad', '#2f80ed', '#ff6ea1', '#e8e8ee'],
  outfitColor: ['#8b5cf6', '#ff4d8d', '#ffd23f', '#3ddc97', '#2f80ed', '#f2f2f7', '#2b2b3a', '#ff8a3d'],
  bg: ['#2a2150', '#ffb3c7', '#ffe28a', '#a8e6cf', '#a3c9ff', '#d5b8ff', '#ffc9a3', '#c9d1d9'],
};
AV.hatColor = AV.outfitColor;
// Hair styles keep stable ids so saved avatars don't change: 6 (the old buzz cut) is retired; unknown ids fall back to 1.
const HAIR_IDS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const AV_COUNTS = { eyes: 5, brows: 4, mouth: 6, beard: 3, extras: 3, glasses: 3, hat: 3, outfit: 4 };
// pet: 0 = none, otherwise (index + 1) into PET_IDS — the server only lets you pick pets you've bought in the Dan Shop.
const PET_IDS = ['duck', 'dog', 'cat', 'bunny', 'fox', 'panda', 'ghost', 'dragon', 'key', 'frog', 'penguin', 'owl', 'hedgehog', 'octopus', 'unicorn', 'alien', 'robot'];
const DEFAULT_AVATAR = { pet: 0, skin: 1, hair: 1, hairColor: 1, eyes: 0, brows: 1, mouth: 0, beard: 0, extras: 0, glasses: 0, hat: 0, hatColor: 0, outfit: 0, outfitColor: 0, bg: 0 };

function randomAvatar() {
  const o = {};
  for (const k of Object.keys(DEFAULT_AVATAR)) {
    if (k === 'pet') { o.pet = 0; continue; }                       // pets are only ever chosen from the ones you own
    if (k === 'hair') { o.hair = HAIR_IDS[Math.floor(Math.random() * HAIR_IDS.length)]; continue; }
    const n = AV_COUNTS[k] || (AV[k] || []).length;
    o[k] = Math.floor(Math.random() * n);
  }
  if (Math.random() < .6) { o.glasses = 0; o.hat = 0; }            // keep most random results uncluttered
  if (Math.random() < .7) o.beard = 0;
  return o;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
}

function mix(a, b, t) {           // blend two #rrggbb colours
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

const INK = '#2b2233';

function avatarSVG(cfg) {
  const c = { ...DEFAULT_AVATAR, ...cfg };
  const at = (arr, k) => arr[c[k] % arr.length];
  const [skin, shade] = at(AV.skin, 'skin');
  const hair = at(AV.hairColor, 'hairColor');
  const outfitC = at(AV.outfitColor, 'outfitColor');
  const hatC = at(AV.hatColor, 'hatColor');
  const bg = at(AV.bg, 'bg');
  const hairStyle = HAIR_IDS.includes(c.hair) ? c.hair : 1, hl = hairLayers(hairStyle, hair), eyes = c.eyes % AV_COUNTS.eyes, brows = c.brows % AV_COUNTS.brows,
    mouth = c.mouth % AV_COUNTS.mouth, beard = c.beard % AV_COUNTS.beard, extras = c.extras % AV_COUNTS.extras,
    glasses = c.glasses % AV_COUNTS.glasses, hat = c.hat % AV_COUNTS.hat, outfit = c.outfit % AV_COUNTS.outfit;
  const stroke = (d, color = INK, w = 2) => svg('path', { d, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const L = [svg('rect', { width: 100, height: 100, fill: bg })];

  L.push(...hl.back);                                              // hair behind the head and shoulders

  // neck, ears, body
  L.push(svg('rect', { x: 43, y: 56, width: 14, height: 20, fill: shade }));
  L.push(svg('circle', { cx: 28, cy: 46, r: 4.6, fill: skin }), svg('circle', { cx: 72, cy: 46, r: 4.6, fill: skin }));
  L.push(svg('path', { d: 'M10 100 Q12 74 36 70 L64 70 Q88 74 90 100Z', fill: outfitC }));
  const dark = mix(outfitC, '#000000', .25), light = mix(outfitC, '#ffffff', .55);
  if (outfit === 1) {                                              // hoodie
    L.push(svg('path', { d: 'M27 80 Q29 66 42 68 Q50 77 58 68 Q71 66 73 80 Q50 94 27 80Z', fill: dark }));
    L.push(svg('path', { d: 'M42 69 Q50 77 58 69Z', fill: shade }), stroke('M45 77 L44 91', '#fff', 1.6), stroke('M55 77 L56 91', '#fff', 1.6));
  } else if (outfit === 2) {                                       // collared shirt
    L.push(svg('path', { d: 'M42 69 Q50 79 58 69Z', fill: shade }));
    L.push(svg('path', { d: 'M40 68 L50 83 L33 80Z', fill: '#fff' }), svg('path', { d: 'M60 68 L50 83 L67 80Z', fill: '#fff' }));
  } else {                                                         // tee (0) / striped tee (3)
    if (outfit === 3) [82, 89, 96].forEach(y => L.push(svg('rect', { x: 11, y, width: 78, height: 3.5, fill: light })));
    L.push(svg('path', { d: 'M41 70 Q50 80 59 70Z', fill: shade }));
  }

  L.push(...hl.mid);                                               // hair that falls over the shoulders
  // head
  L.push(svg('ellipse', { cx: 50, cy: 44, rx: 22, ry: 25, fill: skin }));
  L.push(stroke('M49 49 Q47 54 51 54', shade, 1.5));

  // eyes
  const E = [41, 59];
  if (eyes === 0) E.forEach(x => L.push(svg('circle', { cx: x, cy: 46, r: 2.7, fill: INK })));
  else if (eyes === 1) E.forEach(x => L.push(stroke(`M${x - 4} 47 Q${x} 42 ${x + 4} 47`)));
  else if (eyes === 2) E.forEach(x => L.push(stroke(`M${x - 4} 46 Q${x} 49 ${x + 4} 46`)));
  else if (eyes === 3) E.forEach(x => L.push(svg('ellipse', { cx: x, cy: 46, rx: 4.2, ry: 4.8, fill: '#fff' }), svg('circle', { cx: x, cy: 46.5, r: 2.5, fill: INK }), svg('circle', { cx: x + 1, cy: 45.5, r: .9, fill: '#fff' })));
  else L.push(svg('circle', { cx: 41, cy: 46, r: 2.7, fill: INK }), stroke('M55 47 Q59 42 63 47'));
  const browColor = mix(hair, '#000000', .35);
  if (brows === 1) L.push(stroke('M36 39 Q41 36 46 39', browColor, 2), stroke('M54 39 Q59 36 64 39', browColor, 2));
  else if (brows === 2) L.push(stroke('M36 36 L46 40', browColor, 2), stroke('M64 36 L54 40', browColor, 2));
  else if (brows === 3) L.push(stroke('M36 36 Q41 33 46 36', browColor, 2), stroke('M54 36 Q59 33 64 36', browColor, 2));

  // beard, then mouth (so the mouth stays visible)
  if (beard) L.push(svg('path', { d: 'M31 50 Q33 70 50 72 Q67 70 69 50 Q63 66 50 66 Q37 66 31 50Z', fill: hair, opacity: beard === 1 ? .35 : 1 }));
  if (mouth === 0) L.push(stroke('M42 57 Q50 64 58 57'));
  else if (mouth === 1) L.push(svg('path', { d: 'M41 56 Q50 67 59 56Z', fill: '#fff', stroke: INK, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
  else if (mouth === 2) L.push(stroke('M44 59 L56 59'));
  else if (mouth === 3) L.push(svg('ellipse', { cx: 50, cy: 59, rx: 4, ry: 5, fill: '#5a2a3a' }));
  else if (mouth === 4) L.push(svg('path', { d: 'M42 57 Q50 65 58 57Z', fill: INK }), svg('ellipse', { cx: 50, cy: 62, rx: 3.2, ry: 2.6, fill: '#ff7a9a' }));
  else L.push(stroke('M43 59 Q52 61 58 55'));

  // freckles / blush
  if (extras === 1) [[38, 52], [41, 54], [44, 52], [56, 52], [59, 54], [62, 52]].forEach(([x, y]) => L.push(svg('circle', { cx: x, cy: y, r: .95, fill: mix(skin, '#7a3b12', .55) })));
  if (extras === 2) [36, 64].forEach(x => L.push(svg('circle', { cx: x, cy: 53, r: 5, fill: '#ff6b8a', opacity: .35 })));

  // front hair
  L.push(...hl.front);

  // glasses, hat
  if (glasses === 1) L.push(svg('circle', { cx: 41, cy: 46, r: 7.5, fill: '#ffffff26', stroke: INK, 'stroke-width': 1.8 }), svg('circle', { cx: 59, cy: 46, r: 7.5, fill: '#ffffff26', stroke: INK, 'stroke-width': 1.8 }), stroke('M48.5 46 L51.5 46', INK, 1.8));
  if (glasses === 2) L.push(svg('rect', { x: 33, y: 41, width: 16, height: 10, rx: 4, fill: INK }), svg('rect', { x: 51, y: 41, width: 16, height: 10, rx: 4, fill: INK }), stroke('M48 44 L52 44', INK, 2), svg('path', { d: 'M36 43 L40 43', stroke: '#ffffff80', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
  const hatDark = mix(hatC, '#000000', .25);
  if (hat === 1) L.push(svg('path', { d: 'M26 36 Q26 10 50 10 Q74 10 74 36Z', fill: hatC }), svg('rect', { x: 25, y: 31, width: 50, height: 8, rx: 3, fill: hatDark }), svg('circle', { cx: 50, cy: 9, r: 3.5, fill: mix(hatC, '#ffffff', .5) }));
  if (hat === 2) L.push(svg('path', { d: 'M27 36 Q28 14 50 14 Q72 14 73 36Z', fill: hatC }), svg('path', { d: 'M26 34 Q52 30 84 37 L82 42 Q52 37 26 39Z', fill: hatDark }));

  if (c.pet > 0 && PET_IDS[c.pet - 1]) L.push(svg('g', { transform: 'translate(61 61) scale(.98)' }, ...petParts(PET_IDS[c.pet - 1])));
  return svg('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Avatar', focusable: 'false' }, ...L);
}

// Pets are drawn in a 36×36 box and perched on the avatar's shoulder.
function petParts(id) {
  const e = (cx, cy, rx, ry, fill, extra = {}) => svg('ellipse', { cx, cy, rx, ry, fill, ...extra });
  const c = (cx, cy, r, fill, extra = {}) => svg('circle', { cx, cy, r, fill, ...extra });
  const p = (d, fill, extra = {}) => svg('path', { d, fill, ...extra });
  const line = (d, color = INK, w = 1, extra = {}) => svg('path', { d, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', ...extra });
  const eyes = y => [c(12.5, y, 1.9, INK), c(23.5, y, 1.9, INK), c(13.1, y - .7, .6, '#fff'), c(24.1, y - .7, .6, '#fff')];
  switch (id) {
    case 'duck': return [c(18, 20, 13, '#ffd23f'), line('M15 8 Q18 2 21 8', '#ffd23f', 3), e(18, 26, 8, 4, '#ff8a3d'), ...eyes(17)];
    case 'dog': return [e(6, 15, 5, 9, '#8d5524', { transform: 'rotate(15 6 15)' }), e(30, 15, 5, 9, '#8d5524', { transform: 'rotate(-15 30 15)' }), c(18, 20, 13, '#c68642'),
      e(18, 26, 7, 5, '#f3d9b1'), e(18, 23.5, 2.6, 2, INK), p('M16 29 Q18 34 20 29Z', '#ff7a9a'), ...eyes(17)];
    case 'cat': return [p('M5 14 L8 1 L17 8Z', '#ff9d3d'), p('M31 14 L28 1 L19 8Z', '#ff9d3d'), p('M8 11 L9 5 L13 8Z', '#ffb3c7'), p('M28 11 L27 5 L23 8Z', '#ffb3c7'),
      c(18, 21, 13, '#ffa94d'), ...eyes(19), p('M16.5 23.5 L19.5 23.5 L18 25.5Z', '#ff7a9a'),
      line('M5 25 L12 25.5', '#fff', .8), line('M5 29 L12 27.5', '#fff', .8), line('M31 25 L24 25.5', '#fff', .8), line('M31 29 L24 27.5', '#fff', .8)];
    case 'bunny': return [e(11, 8, 4, 9.5, '#f5f5fa'), e(25, 8, 4, 9.5, '#f5f5fa'), e(11, 8, 2, 6, '#ffb3c7'), e(25, 8, 2, 6, '#ffb3c7'),
      c(18, 23, 12, '#f5f5fa'), ...eyes(22), c(18, 26, 1.6, '#ff7a9a'), svg('rect', { x: 16.5, y: 28, width: 3, height: 3.4, rx: .6, fill: '#fff', stroke: '#c9c9d6', 'stroke-width': .6 })];
    case 'fox': return [p('M4 16 L7 1 L17 9Z', '#ff7a3d'), p('M32 16 L29 1 L19 9Z', '#ff7a3d'), p('M6 8 L7 1 L11 6Z', INK), p('M30 8 L29 1 L25 6Z', INK),
      c(18, 21, 13, '#ff7a3d'), p('M5 26 Q18 19 31 26 Q26 35 18 35 Q10 35 5 26Z', '#fff'), c(18, 28, 2, INK), ...eyes(20)];
    case 'panda': return [c(7, 9, 5, INK), c(29, 9, 5, INK), c(18, 20, 13, '#fff', { stroke: '#dcdce6', 'stroke-width': .8 }),
      e(12, 19, 3.4, 4.5, INK, { transform: 'rotate(-20 12 19)' }), e(24, 19, 3.4, 4.5, INK, { transform: 'rotate(20 24 19)' }), c(12.4, 18.6, 1.2, '#fff'), c(23.6, 18.6, 1.2, '#fff'),
      e(18, 25, 2.3, 1.7, INK), line('M15 28 Q18 31 21 28', INK, 1)];
    case 'ghost': return [p('M4 35 V16 Q4 2 18 2 Q32 2 32 16 V35 L27 31 L22.5 35 L18 31 L13.5 35 L9 31Z', '#f4f1ff', { opacity: .96 }),
      e(13, 15, 2.2, 3, INK), e(23, 15, 2.2, 3, INK), e(18, 23, 2.5, 3, '#5a2a3a'), c(8.5, 21, 2.6, '#ff6b8a', { opacity: .4 }), c(27.5, 21, 2.6, '#ff6b8a', { opacity: .4 })];
    case 'dragon': return [p('M4 15 L-3 3 L10 10Z', '#8b5cf6'), p('M32 15 L39 3 L26 10Z', '#8b5cf6'), p('M10 9 L8 0 L15 6Z', '#ffd23f'), p('M26 9 L28 0 L21 6Z', '#ffd23f'),
      c(18, 21, 13, '#3ddc97'), e(18, 27, 7, 5, '#8ff0c7'), c(15.5, 26.5, .9, INK), c(20.5, 26.5, .9, INK),
      c(12.5, 18, 2.5, '#ffd23f'), c(23.5, 18, 2.5, '#ffd23f'), svg('rect', { x: 12, y: 15.8, width: 1, height: 4.4, rx: .5, fill: INK }), svg('rect', { x: 23, y: 15.8, width: 1, height: 4.4, rx: .5, fill: INK })];
    case 'key': return [svg('rect', { x: 15, y: 18, width: 6, height: 17, rx: 1.5, fill: '#e6b422' }), svg('rect', { x: 20, y: 25, width: 6.5, height: 3.4, rx: 1, fill: '#e6b422' }), svg('rect', { x: 20, y: 30.4, width: 4.8, height: 3.4, rx: 1, fill: '#e6b422' }),
      c(18, 11, 10, '#ffd23f', { stroke: '#d9a441', 'stroke-width': 1.4 }), c(14.4, 10, 1.7, INK), c(21.6, 10, 1.7, INK), c(15, 9.3, .55, '#fff'), c(22.2, 9.3, .55, '#fff'), line('M14.5 14 Q18 17.2 21.5 14', INK, 1.1),
      svg('g', { transform: 'rotate(18 30 6)' }, svg('rect', { x: 25, y: 1, width: 11, height: 9, rx: 2.2, fill: '#ff4d8d' }), c(27.6, 5.5, 1.1, '#fff'), line('M30.5 4 L34 4 M30.5 7 L34 7', '#fff', 1))];
    case 'frog': return [c(18, 22, 13, '#5fd068'), c(11, 11, 6.4, '#5fd068'), c(25, 11, 6.4, '#5fd068'), c(11, 11, 4.2, '#fff'), c(25, 11, 4.2, '#fff'), c(11.6, 11.4, 2, INK), c(24.4, 11.4, 2, INK),
      line('M9 25 Q18 32 27 25', INK, 1.4), c(15.6, 20, .8, '#2f8f3a'), c(20.4, 20, .8, '#2f8f3a'), c(8.6, 24, 2.4, '#ff9db0', { opacity: .55 }), c(27.4, 24, 2.4, '#ff9db0', { opacity: .55 })];
    case 'penguin': return [e(18, 21, 13, 14.5, '#2b2f4a'), e(18, 24, 8.6, 10.6, '#fff'), c(13, 14, 3, '#fff'), c(23, 14, 3, '#fff'), c(13.4, 14.2, 1.5, INK), c(22.6, 14.2, 1.5, INK),
      p('M15.4 18.4 L20.6 18.4 L18 22.4Z', '#ff9d3d'), e(11.5, 34, 4.2, 1.8, '#ff9d3d'), e(24.5, 34, 4.2, 1.8, '#ff9d3d')];
    case 'owl': return [p('M6 13 L8 2 L16 8Z', '#8c6239'), p('M30 13 L28 2 L20 8Z', '#8c6239'), c(18, 21, 13, '#a67c52'), e(18, 26.4, 8, 6.6, '#e9d3b4'),
      c(12, 17, 5.6, '#fff5dc'), c(24, 17, 5.6, '#fff5dc'), c(12, 17, 3.2, '#f5a623'), c(24, 17, 3.2, '#f5a623'), c(12, 17, 1.6, INK), c(24, 17, 1.6, INK),
      p('M15.8 21.2 L20.2 21.2 L18 25Z', '#ff9d3d'), line('M12 29 Q14 31 16 29 M20 29 Q22 31 24 29', '#8c6239', .9)];
    case 'hedgehog': {
      const spikes = [];
      for (let i = 0; i < 11; i++) {
        const a = Math.PI + i * Math.PI / 10, x = 18 + Math.cos(a) * 13, y = 22 + Math.sin(a) * 13, dx = 2.6 * Math.sin(a), dy = 2.6 * Math.cos(a);
        spikes.push(p(`M${x - dx} ${y + dy} L${18 + Math.cos(a) * 17.6} ${22 + Math.sin(a) * 17.6} L${x + dx} ${y - dy}Z`, '#6b4526'));
      }
      return [...spikes, c(18, 22, 13, '#7a5230'), e(18, 26.4, 9.4, 7.4, '#f0d0a8'), c(9.4, 14.6, 3, '#f0d0a8'), c(26.6, 14.6, 3, '#f0d0a8'), ...eyes(21.4), c(18, 25.6, 2.1, INK)];
    }
    case 'octopus': return [...[7.6, 14, 22, 28.4].map(x => e(x, 29.6, 3.5, 6.2, '#a855f7')), e(18, 15, 13, 12.6, '#a855f7'), e(18, 19.6, 11.6, 6, '#a855f7'),
      c(12.5, 16, 3.3, '#fff'), c(23.5, 16, 3.3, '#fff'), c(12.9, 16.4, 1.7, INK), c(23.9, 16.4, 1.7, INK), line('M14.4 22 Q18 25 21.6 22', INK, 1.1),
      c(8.4, 31, .8, '#e9c9ff'), c(14, 32.6, .8, '#e9c9ff'), c(22, 32.6, .8, '#e9c9ff'), c(27.6, 31, .8, '#e9c9ff'), line('M9 8 Q13 4.6 18 4.6', '#d8a8ff', 1.4)];
    case 'unicorn': return [p('M12 12 C1 14 -1 28 7 34 C6 27 9 21 14 17Z', '#ff8fd0'), p('M14 11 C5 19 4 30 10 35 C9 29 12 23 18 17Z', '#c084fc'),
      p('M9 13 L8.4 4.6 L14.6 9.6Z', '#fff'), p('M27 13 L27.6 4.6 L21.4 9.6Z', '#fff'), p('M10.2 10.6 L10 6.8 L12.8 9.2Z', '#ffc8dc'),
      c(18, 23, 12, '#fff', { stroke: '#e6e0f5', 'stroke-width': .8 }), ...eyes(21), e(18, 28.4, 5, 3.4, '#ffc8dc'), c(16.4, 28.4, .8, '#c76d8f'), c(19.6, 28.4, .8, '#c76d8f'),
      p('M18 -1.6 L13.4 12.6 L22.6 12.6Z', '#ffd23f'), line('M14.6 8.6 L21.2 6.2 M16 4.4 L20 2.8', '#e6b422', .9)];
    case 'alien': return [line('M12 6 Q10 2 7 2.4', '#7ee06a', 1.4), c(7, 2.4, 1.7, '#ffd23f'), line('M24 6 Q26 2 29 2.4', '#7ee06a', 1.4), c(29, 2.4, 1.7, '#ffd23f'),
      e(18, 19, 12, 14.6, '#7ee06a'), e(11.4, 18, 4.6, 6.4, INK, { transform: 'rotate(-24 11.4 18)' }), e(24.6, 18, 4.6, 6.4, INK, { transform: 'rotate(24 24.6 18)' }),
      c(10.2, 16, 1.2, '#fff'), c(23.4, 16, 1.2, '#fff'), c(16.6, 24, .7, '#3fa02f'), c(19.4, 24, .7, '#3fa02f'), line('M15.2 28.4 Q18 30.6 20.8 28.4', INK, 1.1)];
    case 'robot': return [svg('rect', { x: 16.5, y: 1.4, width: 3, height: 6, fill: '#8b93a6' }), c(18, 2.4, 2.4, '#ff4d8d'), svg('rect', { x: 4, y: 7, width: 28, height: 25, rx: 6, fill: '#c9d1d9' }),
      svg('rect', { x: 1.4, y: 14, width: 3.6, height: 9, rx: 1.6, fill: '#8b5cf6' }), svg('rect', { x: 31, y: 14, width: 3.6, height: 9, rx: 1.6, fill: '#8b5cf6' }),
      svg('rect', { x: 8, y: 12, width: 8.4, height: 7.4, rx: 2.4, fill: '#2b2f4a' }), svg('rect', { x: 19.6, y: 12, width: 8.4, height: 7.4, rx: 2.4, fill: '#2b2f4a' }),
      svg('rect', { x: 10.2, y: 14.2, width: 4, height: 3, rx: 1, fill: '#3ddc97' }), svg('rect', { x: 21.8, y: 14.2, width: 4, height: 3, rx: 1, fill: '#3ddc97' }),
      svg('rect', { x: 9.6, y: 23.4, width: 16.8, height: 4.8, rx: 2, fill: '#2b2f4a' }), line('M13.8 23.4 L13.8 28.2 M18 23.4 L18 28.2 M22.2 23.4 L22.2 28.2', '#c9d1d9', 1)];
    default: return [];
  }
}

/* ---------- hair ---------- */
// Each style returns three layers: `back` (behind head/body), `mid` (over the shoulders, under the face), `front` (over the face edge).
// Head is an ellipse at (50,44) rx22 ry25; the hairline sits around y≈28–33 and ears at x≈28/72.
function hairLayers(style, hair) {
  const deep = mix(hair, '#000000', .3), lift = mix(hair, '#ffffff', .3);
  const back = [], mid = [], front = [];
  const P = (arr, d, extra = {}) => arr.push(svg('path', { d, fill: hair, ...extra }));
  const C = (arr, cx, cy, r, extra = {}) => arr.push(svg('circle', { cx, cy, r, fill: hair, ...extra }));
  const S = (arr, d, color = deep, w = 1.2, op = 1) => arr.push(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', opacity: op }));
  const mirror = (arr, nodes) => arr.push(svg('g', { transform: 'translate(100 0) scale(-1 1)' }, ...nodes.map(n => n.cloneNode(true))));
  const both = (arr, fn) => { const l = []; fn(l); arr.push(...l); mirror(arr, l); };       // draw the left side, mirror to the right

  switch (style) {
    case 0: {                                                          // box fade — flat boxy top, sides fading toward the ears
      both(front, l => {
        P(l, 'M29.4 33 C28.4 37.6 28 41.4 28.1 45 L30.6 43.4 C31 39.8 31.6 36.4 32.6 32.6Z', { opacity: .42 });
        P(l, 'M28.1 45 C28 47.4 28.3 49.4 28.9 51.2 L30.9 46.6 L30.6 43.4Z', { opacity: .26 });
        P(l, 'M28.9 51.2 C29.2 52.6 29.7 53.6 30.3 54.4 L31.5 49.6 L30.9 46.6Z', { opacity: .13 });
      });
      P(front, 'M29.4 33 C27.8 25 28 19.5 33 16.6 C41 13.6 59 13.6 67 16.6 C72 19.5 72.2 25 70.6 33 C69.6 30.4 66 28.8 61 28.2 C55 27.5 45 27.5 39 28.2 C34 28.8 30.4 30.4 29.4 33Z');
      S(front, 'M34 18.6 C43 16.6 57 16.6 66 18.6', lift, 1.3, .8);
      S(front, 'M32 24 L68 24', deep, .7, .3);
      break;
    }
    case 1: {                                                          // short, side-parted
      P(front, 'M27 46 C23.4 38 22.6 26 31 19 C39 12.6 61 12 69 19 C77.4 26 76.6 38 73 46 L71.6 41 C70.6 35.6 67 32.6 62.6 33.4 C58 29.4 50 27.8 42.4 30.4 C36.4 32.6 33 36 32 41Z');
      S(front, 'M43.5 30 C41.5 24 42 18.5 46 14.4', deep, 1.3, .8);
      S(front, 'M52 26 C60 25 66 27 69.5 32', deep, 1.1, .6);
      S(front, 'M50 18 C58 17 64 19 68 24', lift, 1.3, .7);
      S(front, 'M32 25 C34 22 37 20 40 19', lift, 1.1, .6);
      break;
    }
    case 2: {                                                          // long, centre-parted
      P(back, 'M22.6 46 C17.6 30 24 12.4 50 11.6 C76 12.4 82.4 30 77.4 46 C79.4 58 78.4 70 81 86 C74 92.4 66 90 62 82 L38 82 C34 90 26 92.4 19 86 C21.6 70 20.6 58 22.6 46Z');
      both(mid, l => {
        P(l, 'M28.6 40 C24 52 26.6 64 23 78 C21.6 84 22.4 88.6 25 91 C30.4 92.4 33.4 86.6 33.6 80 C33.8 68 35.4 54 34.8 41Z');
        S(l, 'M29.6 47 C27.6 58 28.6 68 25.6 84', lift, 1.1, .6);
        S(l, 'M32.2 50 C32 62 32.8 72 30.6 84', deep, 1, .5);
      });
      P(front, 'M26.6 46 C22.4 34 23 21 32 16 C41 11.6 59 11.6 68 16 C77 21 77.6 34 73.4 46 C72.4 38 69.4 32 64 29.4 C58 27.6 54 28.4 50 31 C46 28.4 42 27.6 36 29.4 C30.6 32 27.6 38 26.6 46Z');
      S(front, 'M50 31 C50 24 50 18 50 13', deep, 1.2, .6);
      S(front, 'M38 18 C34 22 31 27 30 33', lift, 1.2, .6);
      S(front, 'M62 18 C66 22 69 27 70 33', lift, 1.2, .6);
      break;
    }
    case 3: {                                                          // curly — tight, springy curls
      const ring = [[29, 40, 6], [26.4, 32, 7.6], [29.6, 24, 8], [37.6, 18, 8.6], [48, 14.6, 8.6], [58.4, 15, 8.6], [67.2, 19.2, 8.4], [72.2, 26.4, 7.8], [74, 35, 7.2], [71.6, 42, 5.6]];
      P(front, 'M27.4 44 C22.4 34 23.4 22 32 17 C41 12 59 12 68 17 C76.6 22 77.6 34 72.6 44 C70 36 64 31.6 50 31.6 C36 31.6 30 36 27.4 44Z');
      ring.forEach(([x, y, r]) => C(front, x, y, r));
      [[34.6, 30.4, 5], [42.6, 28.4, 5.2], [51, 27.6, 5.2], [59.4, 28.4, 5.2], [66.4, 31, 4.8]].forEach(([x, y, r]) => C(front, x, y, r));
      ring.slice(1, 9).forEach(([x, y, r], i) => S(front, `M${x - r * .5} ${y + r * .1} C${x - r * .4} ${y - r * .6} ${x + r * .5} ${y - r * .6} ${x + r * .5} ${y}`, deep, 1, .55));
      [[40, 17], [56, 16.4], [68, 21]].forEach(([x, y]) => S(front, `M${x - 3} ${y} C${x - 1} ${y - 2.4} ${x + 2} ${y - 2.4} ${x + 3} ${y - .4}`, lift, 1.1, .8));
      break;
    }
    case 4: {                                                          // fluffy — soft, airy cloud of hair
      P(front, 'M27.4 46 C21 42 18.6 34 22.6 28 C18.6 21.6 23.6 13.6 32 14 C34 6.6 46 4.6 51 9 C57 4.6 68 7.6 68.6 14 C77 13.4 82 21.6 77.4 28 C81.4 34 79 42 72.6 46 C71.6 40 69.6 35.4 66 32.4 C60 29 54 29.8 50 32 C46 29.8 40 29 34 32.4 C30.4 35.4 28.4 40 27.4 46Z');
      S(front, 'M32 20 C34 16.6 38.6 15.6 41.6 17.6', lift, 1.4, .8);
      S(front, 'M56 14.4 C60 11.6 65.6 12.6 67.4 16.4', lift, 1.4, .8);
      S(front, 'M26.4 30 C27 26 30 24 33 24.6', deep, 1.1, .4);
      S(front, 'M73.6 30 C73 26 70 24 67 24.6', deep, 1.1, .4);
      S(front, 'M42 26 C44 23 48 22.6 50 25 C52 22.6 56 23 58 26', deep, 1.1, .35);
      break;
    }
    case 5: {                                                          // bun — pulled-back hair with a top knot
      C(back, 50, 10.4, 9.4);
      S(back, 'M43.4 10.4 C46 6.4 54 6.4 56.6 10.4', lift, 1.3, .7);
      P(front, 'M26.6 46 C23 36 23.4 24 32 18.4 C40 13.4 60 13.4 68 18.4 C76.6 24 77 36 73.4 46 C72.4 38 70 33 65 30 C59.6 27.4 54 26.6 50 27.4 C46 26.6 40.4 27.4 35 30 C30 33 27.6 38 26.6 46Z');
      P(front, 'M42.6 19.6 C44 17.6 56 17.6 57.4 19.6 C56.4 21.6 43.6 21.6 42.6 19.6Z', { fill: deep });
      S(front, 'M38 29 C39 23 42 19.6 46 17.4', deep, 1.1, .6);
      S(front, 'M62 29 C61 23 58 19.6 54 17.4', deep, 1.1, .6);
      S(front, 'M32 27 C34 23 38 20.4 43 19', lift, 1.1, .6);
      break;
    }
    case 7: {                                                          // textured fringe — layered, uneven locks
      P(front, 'M26.6 46 C22.6 34 24 21 33 16 C42 11.6 60 11.6 68 16.4 C76.6 21.4 77.4 34 73.4 46 L72 40 C71 34 68 30.4 63 29 C56 27 44 27 37 29.6 C32 31.6 29 36 28 41Z');
      [[36, 28, 33.4, 36.6], [42, 27.4, 42.4, 38.4], [48.6, 27, 51, 36], [55, 27.2, 59, 37.6], [61.6, 28, 67, 35.4]].forEach(([x0, y0, x1, y1]) =>
        P(front, `M${x0 - 3.4} ${y0 - 1.6} C${x0 - 4} ${y0 + 4} ${x1 - 3} ${y1 - 3} ${x1} ${y1} C${x1 + 1.6} ${y1 - 4.6} ${x0 + 3.4} ${y0 + 2.4} ${x0 + 3.8} ${y0 - 1.6}Z`));
      S(front, 'M40 15.6 C36 18 33.4 22 32.6 27', deep, 1.2, .6);
      S(front, 'M50 13.6 C48 17 47.6 21 48.6 26', deep, 1.2, .6);
      S(front, 'M60 14.4 C62.6 17.6 64 22 63.6 27', deep, 1.2, .6);
      S(front, 'M44 15 C46 14.4 49 14.4 51 14.8', lift, 1.3, .8);
      S(front, 'M35 21 C36 19.6 37.4 18.6 39 18', lift, 1.1, .6);
      break;
    }
    case 8: {                                                          // quiff — short tapered sides, a swept-up pomp at the front
      P(front, 'M27.4 44 C23.8 35 24 25 31 19 C39 13.4 61 13.4 69 19 C76 25 76.2 35 72.6 44 C72 39 70.4 34.6 67 31.6 C62.6 28 57 27.4 50 27.6 C43 27.4 37.4 28 33 31.6 C29.6 34.6 28 39 27.4 44Z');
      P(front, 'M32 30.6 C28.6 20.6 33 10.6 43 7.4 C53 4.4 65 6 71.6 13 C75.4 17.4 74.6 23.6 70.6 27.4 C67.6 24.4 62.6 22.6 58 23.8 C52.6 20.6 44.4 21.6 40.4 25.8 C37.4 28.4 34.6 30 32 30.6Z');
      S(front, 'M35 27 C34.4 19.6 39.4 12.6 47 9.4', deep, 1.3, .6);
      S(front, 'M41 25 C41.4 18.4 47 12 55 9.6', deep, 1.3, .6);
      S(front, 'M50 23.4 C52 17.6 58 12.4 65.6 11.4', deep, 1.3, .55);
      S(front, 'M38 13.6 C44 9.4 52 8 60 9.4', lift, 1.5, .8);
      P(front, 'M27.4 44 C27.4 47 27.8 49.4 28.4 51.4 L30.4 46 L29.8 41Z', { opacity: .3 });
      P(front, 'M72.6 44 C72.6 47 72.2 49.4 71.6 51.4 L69.6 46 L70.2 41Z', { opacity: .3 });
      break;
    }
    case 9: {                                                          // bob — chin-length with a straight fringe
      P(back, 'M22.6 46 C17.4 28 26 12 50 11.4 C74 12 82.6 28 77.4 46 C78.6 56 78 64 76.6 70.4 C75.4 75 70 76 66 73.6 L34 73.6 C30 76 24.6 75 23.4 70.4 C22 64 21.4 56 22.6 46Z');
      both(mid, l => { P(l, 'M27.6 40 C24 52 24.2 62 26.6 69.6 C30.6 72.4 34.8 70.6 35.6 66 C34.2 58 33.6 50 34 40Z'); S(l, 'M28.8 50 C28.4 57 28.8 63 30 67', lift, 1.1, .5); });
      P(front, 'M26.6 44 C22.6 32 24 20 33 15.6 C42 11.4 58 11.4 67 15.6 C76 20 77.4 32 73.4 44 C72.6 38 71 35 68 33.6 C63 36.4 57 35 50 35.4 C43 35 37 36.4 32 33.6 C29 35 27.4 38 26.6 44Z');
      S(front, 'M38 34 C39 29 40 25 40.4 21', deep, 1, .45);
      S(front, 'M50 35 C50 29 50 24 50 19', deep, 1, .45);
      S(front, 'M62 34 C61 29 60 25 59.6 21', deep, 1, .45);
      S(front, 'M32 22 C36 18.6 41 17 46 16.6', lift, 1.3, .7);
      break;
    }
    case 10: {                                                         // ponytail — swept back, tail over the shoulder
      P(back, 'M59 15 C74 8.4 90 22 88 42 C87 56 82 64 75 70 C71.6 66 72.6 60 75.6 54 C79 44 77 30 64 24Z');
      S(back, 'M66 22 C77 26 81 38 78.6 50', lift, 1.3, .6);
      S(back, 'M70 30 C76 38 76 48 72 58', deep, 1.1, .45);
      P(front, 'M26.6 46 C22.6 35 23.4 23.4 32 18 C40.6 12.6 60 12.6 68 18.6 C76.6 24.6 77 36 73.4 46 C72.4 38 70 33 65 30 C59.6 27.4 54 26.6 50 27.4 C46 26.6 40.4 27.4 35 30 C30 33 27.6 38 26.6 46Z');
      S(front, 'M36 29 C38 23 44 18 55 16', deep, 1.1, .6);
      S(front, 'M44 27.6 C47 22 53 18 61 16.6', deep, 1.1, .6);
      S(front, 'M32 26 C34 22 38 19.4 43 18', lift, 1.1, .6);
      P(front, 'M58.6 12 C62 10.6 66.4 13.4 66.4 17.4 C66.4 20.4 63 22 59.6 20.6Z', { fill: '#ff4d8d' });
      break;
    }
    case 11: {                                                         // pigtails
      both(back, l => {
        P(l, 'M31.6 25 C18.4 27 10.6 42 13.4 60 C14.6 68.4 22.6 70 25 62 C27 52 28 43 34 37Z');
        S(l, 'M24 32 C16.4 40 15.4 52 18 62', lift, 1.2, .6);
        S(l, 'M28 38 C24 46 23.6 54 24 61', deep, 1, .45);
      });
      P(front, 'M26.6 44 C22.4 32 24 20 33.6 15.4 C42 11.6 58 11.6 66.4 15.4 C76 20 77.6 32 73.4 44 C72 36.6 69 31.6 64 29.4 C58 27 54 27.6 50 30.4 C46 27.6 42 27 36 29.4 C31 31.6 28 36.6 26.6 44Z');
      S(front, 'M50 30.4 C50 24 50 18 50 13.4', deep, 1.1, .5);
      S(front, 'M36 19 C33 22.6 30.6 26.6 29.4 31', lift, 1.2, .6);
      both(front, l => { C(l, 29.4, 30.4, 3.6, { fill: '#ff4d8d' }); });
      break;
    }
    case 12: {                                                         // wavy shoulder-length
      P(back, 'M22.6 46 C17.4 30 24 12.4 50 11.6 C76 12.4 82.6 30 77.4 46 C80.6 54 76.6 60 79.6 68 C82 74 78 78 74.6 80 L25.4 80 C22 78 18 74 20.4 68 C23.4 60 19.4 54 22.6 46Z');
      both(mid, l => {
        P(l, 'M28.4 38 C23.4 48 30 56 25.4 64 C22.4 70 27.6 76 30.6 79.6 C35 78.6 36 73 34.4 68 C32.4 60 36.4 52 34.6 41Z');
        S(l, 'M29.4 46 C26 54 31 60 27.6 68', lift, 1.1, .6);
        S(l, 'M32.4 48 C30 56 34 62 31.6 72', deep, 1, .45);
      });
      P(front, 'M26.6 46 C22.4 33 24 20.4 33 16 C42 11.6 60 11.6 68 16.4 C76.6 21.4 77.6 34 73.4 46 C72.4 38.6 69.6 33.6 64.6 31 C60 28.6 54 28.4 47 29.6 C41 30.8 36 33 33.4 36.4 C30.4 39 28 42.4 26.6 46Z');
      S(front, 'M46 29.6 C44.6 24 45.4 18.4 48.4 13.6', deep, 1.2, .55);
      S(front, 'M56 17 C62 18 67 22 69.4 28', lift, 1.2, .6);
      S(front, 'M34 21 C36 19 38.6 17.6 41.6 17', lift, 1.2, .55);
      break;
    }
    case 13: {                                                         // slick back — combed back, tapered sides
      P(front, 'M27.6 44 C23.6 34 23.4 24 31 18 C39 12 61 12 69 18 C76.6 24 76.4 34 72.4 44 C72 38.6 70.4 34 67 30.6 C62.4 26.4 56 25 50 25 C44 25 37.6 26.4 33 30.6 C29.6 34 28 38.6 27.6 44Z');
      [['M34 29 C35 22.4 41 16.6 50 14.4'], ['M40 27.4 C41.4 21 46.4 16.4 54 14.6'], ['M46.4 26.4 C48 20.6 52.6 16.6 60 15.4'], ['M54 26.6 C56 21.4 60.4 18 66 17.4'], ['M61 28 C62.6 23.4 65.6 20.6 69 20.4']].forEach(([d]) => S(front, d, deep, 1.2, .6));
      S(front, 'M36 24 C41 19 48 16.6 57 16.4', lift, 1.5, .8);
      P(front, 'M27.6 44 C27.6 47 28 49.4 28.6 51.4 L30.6 46 L30 41Z', { opacity: .3 });
      P(front, 'M72.4 44 C72.4 47 72 49.4 71.4 51.4 L69.4 46 L70 41Z', { opacity: .3 });
      break;
    }
    case 14: {                                                         // afro — big, round, springy
      const ring = [[50, 9.6, 9], [39, 11, 9], [61, 11, 9], [30, 17.4, 9], [70, 17.4, 9], [24, 26.4, 9], [76, 26.4, 9], [21.6, 36.6, 8.4], [78.4, 36.6, 8.4], [23.4, 46, 6.6], [76.6, 46, 6.6]];
      C(back, 50, 32, 27.4);
      ring.forEach(([x, y, r]) => C(back, x, y, r));
      ring.slice(0, 9).forEach(([x, y, r]) => S(back, `M${x - r * .5} ${y + r * .3} C${x - r * .4} ${y - r * .5} ${x + r * .5} ${y - r * .5} ${x + r * .5} ${y + r * .2}`, deep, 1, .45));
      P(front, 'M28.2 44 C25.4 28 32 16.4 50 16 C68 16.4 74.6 28 71.8 44 C68.4 35 60 30.4 50 30.4 C40 30.4 31.6 35 28.2 44Z');
      [[40, 17], [58, 16.6], [30, 25], [70, 25]].forEach(([x, y]) => S(back, `M${x - 3.6} ${y} C${x - 1.4} ${y - 2.6} ${x + 2.4} ${y - 2.6} ${x + 3.6} ${y - .4}`, lift, 1.2, .8));
      break;
    }
    case 15: {                                                         // messy — tousled, uneven tufts growing out of the crop
      P(front, 'M26.6 46 C22.6 35 23 23 32 17.6 C41 12.4 60 12.4 68.4 18 C77 23.6 77.4 35 73.4 46 L72 40 C71 34 68 31 63.4 30.4 C58 29 52 29.4 47 30.4 C41 31.4 36 33 32.6 37 C30.4 39 29 42 28 44Z');
      [[30, 22, 25, 11.6, 37.4, 23], [40, 19, 36, 6.6, 47, 19], [51, 18, 52.4, 4.6, 59, 19], [62, 19, 69, 8, 68, 24], [70, 25, 80, 17, 75, 32]].forEach(([x0, y0, tx, ty, x1, y1]) =>
        P(front, `M${x0} ${y0} C${x0 - 2} ${y0 - 5} ${tx - 1} ${ty + 3} ${tx} ${ty} C${tx + 4} ${ty + 5} ${x1 - 1} ${y1 - 8} ${x1} ${y1}Z`));
      [[39, 32.4, 36.4, 38.6, 41.6, 36.4], [50, 30.2, 51.4, 37, 54.6, 33.6], [60.4, 31, 65.4, 36.6, 64.4, 31.6]].forEach(([x0, y0, tx, ty, x1, y1]) =>
        P(front, `M${x0 - 3} ${y0 - 3} C${x0 - 3.6} ${y0 + 1} ${tx - 1.4} ${ty - 2} ${tx} ${ty} C${tx + 2} ${ty - 3} ${x1 + 1} ${y1 - 2} ${x1 + 2.6} ${y1 - 5}Z`));
      S(front, 'M38 25 C41 21 45 19 49 18.6', deep, 1.1, .55);
      S(front, 'M55 19 C60 19 64 21 67 25', deep, 1.1, .55);
      break;
    }
    case 16: {                                                         // curtains — centre part, sweeping down past the temples
      P(front, 'M26.6 47 C22.4 35 23.6 21.4 33 16.4 C42 11.6 58 11.6 67 16.4 C76.4 21.4 77.6 35 73.4 47 C72.6 40 69 33.4 62 29.6 C57 27 53 27.6 50 30.6 C47 27.6 43 27 38 29.6 C31 33.4 27.4 40 26.6 47Z');
      both(front, l => {
        P(l, 'M50 29.8 C43.4 26.6 35.6 29.6 31.6 37 C29.4 41 28.4 45 27.8 49 C30 50.8 32.6 49.6 33.8 46 C35.2 40.6 39.4 34.4 46.6 31.2 C48.2 30.6 49.2 30.2 50 29.8Z');
        S(l, 'M44 31 C39.6 32 35.4 35.6 32.6 41.4', lift, 1, .5);
      });
      S(front, 'M50 30.6 C50 24 50 18 50 13.4', deep, 1.1, .5);
      S(front, 'M38 18 C34 21.6 31 26.4 29.6 32', lift, 1.2, .55);
      S(front, 'M62 18 C66 21.6 69 26.4 70.4 32', lift, 1.2, .55);
      break;
    }
    case 17: {                                                         // space buns
      both(back, l => { C(l, 32.6, 12.8, 8.8); S(l, 'M26.8 12.4 C28.6 9 34.4 7.8 37.8 10.6', lift, 1.2, .7); });
      P(front, 'M26.6 44 C22.6 32 24.4 21 33.6 16.4 C42 12.4 58 12.4 66.4 16.4 C75.6 21 77.4 32 73.4 44 C72 36.6 69 31.6 64 29.4 C58 27 54 27.6 50 30.4 C46 27.6 42 27 36 29.4 C31 31.6 28 36.6 26.6 44Z');
      S(front, 'M50 30.4 C50 24 50 18.4 50 14', deep, 1.1, .5);
      S(front, 'M38 19.6 C35 22.4 32.6 26.4 31 31', lift, 1.2, .6);
      both(front, l => { S(l, 'M26.6 19.2 C29.4 23.2 36 23.2 38.8 19.2', '#ff4d8d', 2.6, 1); });
      break;
    }
    default: return hairLayers(1, hair);
  }
  return { back, mid, front };
}

function robotSVG() {
  return svg('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'DANY AI robot avatar', focusable: 'false' },
    svg('rect', { width: 100, height: 100, fill: '#2a2150' }),
    svg('path', { d: 'M18 100 Q20 78 50 76 Q80 78 82 100Z', fill: '#8b5cf6' }),
    svg('rect', { x: 15, y: 42, width: 7, height: 16, rx: 3, fill: '#8b5cf6' }), svg('rect', { x: 78, y: 42, width: 7, height: 16, rx: 3, fill: '#8b5cf6' }),
    svg('rect', { x: 22, y: 28, width: 56, height: 46, rx: 13, fill: '#c9d1d9' }),
    svg('path', { d: 'M50 28 L50 17', stroke: '#c9d1d9', 'stroke-width': 3, 'stroke-linecap': 'round' }), svg('circle', { cx: 50, cy: 14, r: 4.5, fill: '#ffd23f' }),
    svg('rect', { x: 32, y: 42, width: 14, height: 11, rx: 5, fill: '#3ddc97' }), svg('rect', { x: 54, y: 42, width: 14, height: 11, rx: 5, fill: '#3ddc97' }),
    svg('path', { d: 'M38 63 L62 63 M43 60 L43 66 M50 60 L50 66 M57 60 L57 66', stroke: '#2b2233', 'stroke-width': 2, 'stroke-linecap': 'round' }));
}

// <div class="av sm">…svg…</div> for a user object ({ avatar, bot }). size: xs | sm | (default) | lg | xl
function avatarEl(user, size = '') {
  const d = document.createElement('div');
  d.className = `av ${size}`.trim();
  d.append(user && user.bot ? robotSVG() : avatarSVG(user && user.avatar));
  return d;
}
