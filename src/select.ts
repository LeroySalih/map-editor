// Box (marquee) select: which terrain pieces and markers (objectives, spawn points) does a rectangle touch? Pure geometry, millimetres.
import { CLOSED, isStraight, type Feature, type Pt } from './model';

/** Anything placed as a point: an objective or a spawn point. */
export interface Marker { id: string; x: number; y: number; label?: string }

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const rectOf = (a: Pt, b: Pt): Rect => ({
  x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]),
});
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const inside = (r: Rect, p: Pt): boolean => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;

/** Does the segment a-b pass through the rectangle? (Liang-Barsky clipping.) */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;            // parallel to this edge: in or out
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a[0] - r.x0) && clip(dx, r.x1 - a[0]) && clip(-dy, a[1] - r.y0) && clip(dy, r.y1 - a[1]);
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How far a line-type piece reaches either side of its centre line, roughly its drawn half width. */
function reach(f: Feature): number {
  switch (f.type) {
    case 'river': return (f.width ?? 6) / 2 + 0.6;
    case 'bridge': return 4;
    case 'port': return 5;   // the T-shaped head is wider than the deck
    case 'wall': return 1.6;
    case 'road': return 1;
    default: return 0;
  }
}

/** True when the rectangle touches the piece: any of its points or edges is in the box, or the box sits inside a filled area. */
export function featureHitsRect(f: Feature, box: Rect): boolean {
  const pts = isStraight(f.type) && f.points.length > 2 ? [f.points[0], f.points[f.points.length - 1]] : f.points;
  if (!pts.length) return false;
  const closed = CLOSED[f.type];
  const r = grow(box, reach(f));
  if (pts.some((p) => inside(r, p))) return true;
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i++) if (segmentHitsRect(pts[i], pts[(i + 1) % pts.length], r)) return true;
  return closed && pts.length >= 3 && pointInPolygon([box.x0, box.y0], pts);   // the box is wholly inside this hill, sea, wood or desert
}

/** A marker is about 5 mm in radius (a spawn diamond reaches 6.4 mm, close enough). */
export function markerHitsRect(o: Pick<Marker, 'x' | 'y'>, box: Rect, radius = 5): boolean {
  const nx = Math.max(box.x0, Math.min(o.x, box.x1)), ny = Math.max(box.y0, Math.min(o.y, box.y1));
  return Math.hypot(o.x - nx, o.y - ny) <= radius;
}

/** The ids of everything the box touches. */
export function idsInRect(features: Feature[], markers: Marker[], box: Rect): string[] {
  return [
    ...features.filter((f) => featureHitsRect(f, box)).map((f) => f.id),
    ...markers.filter((o) => markerHitsRect(o, box)).map((o) => o.id),
  ];
}
