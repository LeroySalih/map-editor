import { mulberry32 } from './rng';
import { MARGIN, SHEET, uid, type Feature, type Pt } from './model';

const X0 = MARGIN, X1 = SHEET.w - MARGIN, Y0 = MARGIN + 6, Y1 = SHEET.h - MARGIN - 22;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function blob(r: () => number, cx: number, cy: number, rad: number, n = 10): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = rad * (0.65 + r() * 0.5);
    pts.push([clamp(cx + Math.cos(a) * rr, X0, X1), clamp(cy + Math.sin(a) * rr, Y0, Y1)]);
  }
  return pts;
}

export function genBlobs(type: 'hill' | 'wood' | 'desert', count: number, seed: number): Feature[] {
  const r = mulberry32(seed);
  const rad = type === 'desert' ? [50, 80] : type === 'hill' ? [22, 40] : [14, 30];
  return Array.from({ length: count }, () => ({
    id: uid(), type,
    points: blob(r, X0 + r() * (X1 - X0), Y0 + r() * (Y1 - Y0), rad[0] + r() * (rad[1] - rad[0])),
  }));
}

/** A meandering river from one edge to the opposite edge. */
export function genRiver(seed: number): Feature {
  const r = mulberry32(seed);
  const horizontal = r() < 0.5;
  const steps = 9;
  const pts: Pt[] = [];
  let off = 0.25 + r() * 0.5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    off = clamp(off + (r() - 0.5) * 0.28, 0.1, 0.9);
    pts.push(horizontal
      ? [X0 + t * (X1 - X0), Y0 + off * (Y1 - Y0)]
      : [X0 + off * (X1 - X0), Y0 + t * (Y1 - Y0)]);
  }
  return { id: uid(), type: 'river', points: pts, width: 5 + r() * 3 };
}

/** A sea along one edge with a wavy coastline. */
export function genSea(seed: number): Feature {
  const r = mulberry32(seed);
  const edge = Math.floor(r() * 4);
  const depth = 35 + r() * 35;
  const pts: Pt[] = [];
  const n = 8;
  const along = (t: number, d: number): Pt => {
    switch (edge) {
      case 0: return [X0 + t * (X1 - X0), Y0 + d];
      case 1: return [X0 + t * (X1 - X0), Y1 - d];
      case 2: return [X0 + d, Y0 + t * (Y1 - Y0)];
      default: return [X1 - d, Y0 + t * (Y1 - Y0)];
    }
  };
  for (let i = 0; i <= n; i++) pts.push(along(i / n, depth * (0.6 + r() * 0.6)));
  pts.push(along(1, 0), along(0, 0));
  return { id: uid(), type: 'sea', points: pts };
}

/** A full random map: a couple of big features plus scatter. */
export function genMap(seed: number): Feature[] {
  const r = mulberry32(seed);
  const out: Feature[] = [];
  if (r() < 0.6) out.push(genSea(seed + 1));
  if (r() < 0.5) out.push(...genBlobs('desert', 1, seed + 2));
  out.push(genRiver(seed + 3));
  out.push(...genBlobs('hill', 2 + Math.floor(r() * 3), seed + 4));
  out.push(...genBlobs('wood', 3 + Math.floor(r() * 4), seed + 5));
  return out;
}
