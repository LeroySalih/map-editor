import { centroid, scaleAbout, smoothPath } from './geometry';
import { CLOSED, MARGIN, SHEET, type Feature, type MapDoc } from './model';

export const PALETTE = {
  paper: '#e9dfc7', ink: '#1c1a17', hill: '#b9a77c', wood: '#7c8f62',
  sea: '#6d8fa3', desert: '#dcc58a', road: '#5b4a3a', accent: '#8c2f2a',
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

function featureSvg(f: Feature): string {
  const id = `data-id="${esc(f.id)}"`;
  if (!CLOSED[f.type]) {
    const d = smoothPath(f.points, false);
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

/** Corner brackets and a double rule: original gothic-industrial framing. */
function frame(doc: MapDoc): string {
  const { w, h } = SHEET, m = MARGIN, i = m - 3, L = 14;
  const corner = (x: number, y: number, sx: number, sy: number) =>
    `<path d="M${x},${y + sy * L} V${y} H${x + sx * L} M${x + sx * 3},${y + sy * (L - 3)} V${y + sy * 3} H${x + sx * (L - 3)}" fill="none" stroke="${PALETTE.ink}" stroke-width=".9"/>`;
  const rules = doc.rules.split('\n').slice(0, 4);
  const rulesSvg = rules.map((t, n) =>
    `<text x="${m + 2}" y="${h - m - 12 + n * 4.2}" font-family="${BODY_FONT}" font-size="3.4" fill="${PALETTE.ink}">${esc(t)}</text>`).join('');
  return `<g id="frame">
<rect x="${i}" y="${i}" width="${w - 2 * i}" height="${h - 2 * i}" fill="none" stroke="${PALETTE.ink}" stroke-width="1.4"/>
<rect x="${m}" y="${m}" width="${w - 2 * m}" height="${h - 2 * m}" fill="none" stroke="${PALETTE.ink}" stroke-width=".4"/>
${corner(i, i, 1, 1)}${corner(w - i, i, -1, 1)}${corner(i, h - i, 1, -1)}${corner(w - i, h - i, -1, -1)}
<rect x="${m}" y="${m}" width="${w - 2 * m}" height="9" fill="${PALETTE.ink}"/>
<text x="${w / 2}" y="${m + 6.6}" text-anchor="middle" font-family="${TITLE_FONT}" font-size="7" fill="${PALETTE.paper}">${esc(doc.title)}</text>
<rect x="${m}" y="${h - m - 18}" width="${w - 2 * m}" height="18" fill="${PALETTE.paper}" fill-opacity=".92" stroke="${PALETTE.ink}" stroke-width=".4"/>
${rulesSvg}
</g>`;
}

function objectivesSvg(doc: MapDoc): string {
  return doc.objectives.map((o) =>
    `<g data-obj="${esc(o.id)}"><circle cx="${o.x}" cy="${o.y}" r="5" fill="${PALETTE.accent}" stroke="${PALETTE.ink}" stroke-width=".8"/>` +
    `<path d="M${o.x - 7},${o.y} h3 M${o.x + 4},${o.y} h3 M${o.x},${o.y - 7} v3 M${o.x},${o.y + 4} v3" stroke="${PALETTE.ink}" stroke-width=".7"/>` +
    `<text x="${o.x}" y="${o.y + 2}" text-anchor="middle" font-family="${BODY_FONT}" font-size="6" font-weight="bold" fill="${PALETTE.paper}">${esc(o.label)}</text></g>`).join('');
}

/** Order matters: big flat areas first, linework and markers on top. */
const ORDER = ['desert', 'sea', 'hill', 'wood', 'river', 'road'];

export function renderSvg(doc: MapDoc, standalone = false): string {
  const feats = [...doc.features].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  const attrs = standalone
    ? `xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm"`
    : '';
  return `<svg ${attrs} viewBox="0 0 ${SHEET.w} ${SHEET.h}">${defs}` +
    `<rect width="${SHEET.w}" height="${SHEET.h}" fill="${PALETTE.paper}"/>` +
    `<g id="terrain">${feats.map(featureSvg).join('')}</g>${objectivesSvg(doc)}${frame(doc)}</svg>`;
}
