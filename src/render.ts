import { centroid, scaleAbout, smoothPath } from './geometry';
import { CLOSED, DEFAULT_BG, GRID_MM, MARGIN, SHEET, isHex, isStraight, type Feature, type MapDoc } from './model';

export const PALETTE = {
  paper: '#e9dfc7', ink: '#1c1a17', hill: '#b9a77c', wood: '#7c8f62',
  sea: '#6d8fa3', desert: '#dcc58a', road: '#5b4a3a', accent: '#8c2f2a',
  spawn: '#2f6f73', stone: '#9a9486', plank: '#a07c4c', pier: '#6b5238',
};
const TITLE_FONT = `'UnifrakturCook','Old English Text MT',Georgia,serif`;
const BODY_FONT = `'Arial Narrow','Roboto Condensed',Arial,sans-serif`;

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const defs = `<defs>
<pattern id="p-sea" width="8" height="5" patternUnits="userSpaceOnUse"><path d="M0,3 q2,-2 4,0 t4,0" fill="none" stroke="${PALETTE.ink}" stroke-opacity=".35" stroke-width=".4"/></pattern>
<pattern id="p-desert" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r=".35" fill="${PALETTE.ink}" fill-opacity=".45"/><circle cx="4.5" cy="4.5" r=".35" fill="${PALETTE.ink}" fill-opacity=".45"/></pattern>
<pattern id="p-wood" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M3.5,1 L5.7,5 H1.3 Z" fill="${PALETTE.ink}" fill-opacity=".5"/></pattern>
</defs>`;

const FILL: Record<string, string> = {
  hill: PALETTE.hill, wood: PALETTE.wood, sea: PALETTE.sea, desert: PALETTE.desert,
};
const PATTERN: Record<string, string> = { sea: 'p-sea', desert: 'p-desert', wood: 'p-wood' };

/** Bridge and port: a straight piece drawn in a local frame (x along the piece). */
function straightSvg(f: Feature): string {
  const a = f.points[0], b = f.points[f.points.length - 1];
  const L = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
  if (f.points.length < 2 || L < 0.01) return '';
  const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const k = PALETTE.ink;
  const planks = (w: number, step: number) => {
    let d = '';
    for (let x = step; x < L; x += step) d += `M${x.toFixed(2)},${-w / 2}V${w / 2}`;
    return d;
  };
  let body = '';
  if (f.type === 'bridge') {
    const w = 7;
    body = `<rect y="${-w / 2}" width="${L}" height="${w}" fill="${PALETTE.plank}"/>` +
      `<path d="${planks(w, 2)}" stroke="${k}" stroke-opacity=".45" stroke-width=".35"/>` +
      `<path d="M0,${-w / 2}H${L}M0,${w / 2}H${L}" stroke="${k}" stroke-width="1"/>` +
      `<rect x="-.8" y="${-w / 2 - .6}" width="1.6" height="${w + 1.2}" fill="${k}"/>` +
      `<rect x="${L - .8}" y="${-w / 2 - .6}" width="1.6" height="${w + 1.2}" fill="${k}"/>`;
  } else {
    const w = 5;
    let posts = '';
    for (let x = 0; x <= L + 0.01; x += 6) {
      posts += `<circle cx="${x.toFixed(2)}" cy="${-w / 2 - .4}" r=".8"/><circle cx="${x.toFixed(2)}" cy="${w / 2 + .4}" r=".8"/>`;
    }
    body = `<rect y="${-w / 2}" width="${L}" height="${w}" fill="${PALETTE.pier}" stroke="${k}" stroke-width=".7"/>` +
      `<path d="${planks(w, 2)}" stroke="${k}" stroke-opacity=".4" stroke-width=".3"/>` +
      `<rect x="${L - 1.5}" y="${-w}" width="3.5" height="${2 * w}" fill="${PALETTE.pier}" stroke="${k}" stroke-width=".7"/>` +
      `<g fill="${k}">${posts}</g>`;
  }
  // Wide invisible stroke so thin pieces are easy to select.
  const hit = `<line x2="${L}" stroke="transparent" stroke-width="6"/>`;
  return `<g data-id="${esc(f.id)}" transform="translate(${a[0].toFixed(2)},${a[1].toFixed(2)}) rotate(${ang.toFixed(2)})">${body}${hit}</g>`;
}

function featureSvg(f: Feature): string {
  if (isStraight(f.type)) return straightSvg(f);
  const id = `data-id="${esc(f.id)}"`;
  if (!CLOSED[f.type]) {
    const d = smoothPath(f.points, false);
    if (f.type === 'wall') {
      // Straight segments with sharp corners: a stone wall, not a curve.
      const d = 'M' + f.points.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L');
      const line = (extra: string) => `<path d="${d}" fill="none" stroke-linejoin="miter" stroke-linecap="butt" ${extra}/>`;
      return `<g ${id}>${line(`stroke="${PALETTE.ink}" stroke-width="3.2"`)}${line(`stroke="${PALETTE.stone}" stroke-width="2"`)}` +
        `${line(`stroke="${PALETTE.ink}" stroke-opacity=".55" stroke-width="2" stroke-dasharray=".35 3.65"`)}` +
        `${line('stroke="transparent" stroke-width="6" stroke-linejoin="round"')}</g>`;
    }
    if (f.type === 'river') {
      const w = f.width ?? 6;
      return `<g ${id}><path d="${d}" fill="none" stroke="${PALETTE.ink}" stroke-width="${w + 1.2}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${d}" fill="none" stroke="${PALETTE.sea}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    }
    return `<g ${id}><path d="${d}" fill="none" stroke="${PALETTE.road}" stroke-width="1.6" stroke-dasharray="5 2.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  const d = smoothPath(f.points, true);
  let out = `<g ${id}><path d="${d}" fill="${FILL[f.type]}" stroke="${PALETTE.ink}" stroke-width=".9" stroke-linejoin="round"/>`;
  if (PATTERN[f.type]) out += `<path d="${d}" fill="url(#${PATTERN[f.type]})" stroke="none"/>`;
  if (f.type === 'hill') {
    const c = centroid(f.points);
    for (const k of [0.72, 0.45]) {
      out += `<path d="${smoothPath(scaleAbout(f.points, c, k), true)}" fill="none" stroke="${PALETTE.ink}" stroke-opacity=".6" stroke-width=".5"/>`;
    }
  }
  return out + '</g>';
}

/** Flat-top hex grid, one path. Each hex draws only its N, NE and SE edges so
 *  every shared edge is drawn once; the range runs one hex past the border and is clipped. */
export function hexGridPath(): string {
  const h = GRID_MM / 2;
  const R = GRID_MM / Math.sqrt(3);
  const f = (v: number) => v.toFixed(2);
  let d = '';
  for (let c = 0; ; c++) {
    const cx = MARGIN + R + c * 1.5 * R;
    if (cx - R > SHEET.w - MARGIN) break;
    const off = c % 2 ? h : 0;
    for (let row = -1; ; row++) {
      const cy = MARGIN + h + off + row * GRID_MM;
      if (cy - h > SHEET.h - MARGIN) break;
      d += `M${f(cx - R / 2)},${f(cy - h)}H${f(cx + R / 2)}L${f(cx + R)},${f(cy)}L${f(cx + R / 2)},${f(cy + h)}`;
    }
  }
  return d;
}

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** Linework colour for the frame, grid and text: dark ink on a light sheet, light on a dark one. */
export const lineColourFor = (bg: string): string => (luminance(bg) < 0.25 ? PALETTE.paper : PALETTE.ink);

function gridSvg(fg: string): string {
  const m = MARGIN;
  return `<clipPath id="grid-clip"><rect x="${m}" y="${m}" width="${SHEET.w - 2 * m}" height="${SHEET.h - 2 * m}"/></clipPath>` +
    `<path id="hexgrid" d="${hexGridPath()}" clip-path="url(#grid-clip)" fill="none" stroke="${fg}" stroke-opacity=".4" stroke-width=".3" stroke-linejoin="round"/>`;
}

/** Corner brackets and a double rule: original gothic-industrial framing. */
function frame(doc: MapDoc, bg: string, fg: string): string {
  const { w, h } = SHEET, m = MARGIN, i = m - 3, L = 14;
  const corner = (x: number, y: number, sx: number, sy: number) =>
    `<path d="M${x},${y + sy * L} V${y} H${x + sx * L} M${x + sx * 3},${y + sy * (L - 3)} V${y + sy * 3} H${x + sx * (L - 3)}" fill="none" stroke="${fg}" stroke-width=".9"/>`;
  const rules = doc.rules.split('\n').slice(0, 4);
  const rulesSvg = rules.map((t, n) =>
    `<text x="${m + 2}" y="${h - m - 12 + n * 4.2}" font-family="${BODY_FONT}" font-size="3.4" fill="${fg}">${esc(t)}</text>`).join('');
  return `<g id="frame">
<rect x="${i}" y="${i}" width="${w - 2 * i}" height="${h - 2 * i}" fill="none" stroke="${fg}" stroke-width="1.4"/>
<rect x="${m}" y="${m}" width="${w - 2 * m}" height="${h - 2 * m}" fill="none" stroke="${fg}" stroke-width=".4"/>
${corner(i, i, 1, 1)}${corner(w - i, i, -1, 1)}${corner(i, h - i, 1, -1)}${corner(w - i, h - i, -1, -1)}
<rect x="${m}" y="${m}" width="${w - 2 * m}" height="9" fill="${fg}"/>
<text x="${w / 2}" y="${m + 6.6}" text-anchor="middle" font-family="${TITLE_FONT}" font-size="7" fill="${bg}">${esc(doc.title)}</text>
<rect x="${m}" y="${h - m - 18}" width="${w - 2 * m}" height="18" fill="${bg}" fill-opacity=".92" stroke="${fg}" stroke-width=".4"/>
${rulesSvg}
</g>`;
}

function objectivesSvg(doc: MapDoc, fg: string): string {
  return doc.objectives.map((o) =>
    `<g data-obj="${esc(o.id)}"><circle cx="${o.x}" cy="${o.y}" r="5" fill="${PALETTE.accent}" stroke="${PALETTE.ink}" stroke-width=".8"/>` +
    `<path d="M${o.x - 7},${o.y} h3 M${o.x + 4},${o.y} h3 M${o.x},${o.y - 7} v3 M${o.x},${o.y + 4} v3" stroke="${fg}" stroke-width=".7"/>` +
    `<text x="${o.x}" y="${o.y + 2}" text-anchor="middle" font-family="${BODY_FONT}" font-size="6" font-weight="bold" fill="${PALETTE.paper}">${esc(o.label)}</text>` +
    // A bigger invisible target on top, so a marker is easy to click (the crosshair ticks and label alone are hard to hit).
    `<circle cx="${o.x}" cy="${o.y}" r="9" fill="transparent"/></g>`).join('');
}

/** Spawn points: a lettered diamond inside a dashed ring, in teal so they never read as objectives. */
function spawnsSvg(doc: MapDoc, fg: string): string {
  return (doc.spawns ?? []).map((s) => {
    const { x, y } = s;
    return `<g data-spawn="${esc(s.id)}">` +
      `<circle cx="${x}" cy="${y}" r="8.2" fill="none" stroke="${fg}" stroke-width=".5" stroke-dasharray="1.6 1.4"/>` +
      `<path d="M${x},${y - 6.4}L${x + 5.4},${y}L${x},${y + 6.4}L${x - 5.4},${y}Z" fill="${PALETTE.spawn}" stroke="${PALETTE.ink}" stroke-width=".8" stroke-linejoin="round"/>` +
      `<text x="${x}" y="${y + 2.1}" text-anchor="middle" font-family="${BODY_FONT}" font-size="6" font-weight="bold" fill="${PALETTE.paper}">${esc(s.label)}</text>` +
      `<circle cx="${x}" cy="${y}" r="9" fill="transparent"/></g>`;
  }).join('');
}

/** Order matters: big flat areas first, linework and markers on top. */
const ORDER = ['desert', 'sea', 'hill', 'wood', 'river', 'road', 'port', 'bridge', 'wall'];

export function renderSvg(doc: MapDoc, standalone = false): string {
  const feats = [...doc.features].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  const bg = isHex(doc.background) ? doc.background : DEFAULT_BG; // never trust a colour into the SVG
  const fg = lineColourFor(bg);
  const attrs = standalone
    ? `xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm"`
    : '';
  return `<svg ${attrs} viewBox="0 0 ${SHEET.w} ${SHEET.h}">${defs}` +
    `<rect width="${SHEET.w}" height="${SHEET.h}" fill="${bg}"/>` +
    `<g id="terrain">${feats.map(featureSvg).join('')}</g>${doc.grid ? gridSvg(fg) : ''}${spawnsSvg(doc, fg)}${objectivesSvg(doc, fg)}${frame(doc, bg, fg)}</svg>`;
}
