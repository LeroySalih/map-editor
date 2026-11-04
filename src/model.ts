export type Terrain =
  | 'hill' | 'river' | 'sea' | 'wood' | 'desert' | 'road'
  | 'wall' | 'bridge' | 'port';
export type Pt = [number, number];

export interface Feature { id: string; type: Terrain; points: Pt[]; width?: number }
export interface Objective { id: string; x: number; y: number; label: string }
export interface MapDoc {
  version: 3;
  title: string;
  rules: string;
  seed: number;
  /** Show the hex grid overlay (also exported). */
  grid: boolean;
  /** Sheet background colour, #rrggbb. */
  background: string;
  features: Feature[];
  objectives: Objective[];
}

/** All units are millimetres. Sheet is A3 landscape, Y down (SVG space). */
export const SHEET = { w: 420, h: 297 };
export const MARGIN = 14;
/** Default sheet colour (parchment). */
export const DEFAULT_BG = '#e9dfc7';
export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/** Hex grid: distance across flats in mm (2 cm). Flat-top hexes. */
export const GRID_MM = 20;

/** Closed terrain is a filled area; open terrain is a stroked line. */
export const CLOSED: Record<Terrain, boolean> = {
  hill: true, sea: true, wood: true, desert: true, river: false, road: false,
  wall: false, bridge: false, port: false,
};

/** Straight two-point pieces: click the start, then the end. (Walls are multi-point polylines.) */
export const STRAIGHT: readonly Terrain[] = ['bridge', 'port'];
export const isStraight = (t: string): boolean => (STRAIGHT as readonly string[]).includes(t);

export const TERRAIN_LABEL: Record<Terrain, string> = {
  hill: 'Hills', river: 'River', sea: 'Sea', wood: 'Woods', desert: 'Desert', road: 'Road',
  wall: 'Wall', bridge: 'Bridge', port: 'Port',
};

export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function newDoc(): MapDoc {
  return {
    version: 3,
    title: 'Untitled Mission',
    rules: 'Objective: hold the marked positions.\nDeployment: opposite long edges, 12" in.',
    seed: 1,
    grid: true,
    background: DEFAULT_BG,
    features: [],
    objectives: [],
  };
}

const TERRAINS = Object.keys(CLOSED);

/** Throws on anything that is not a map file we can safely render. */
export function validate(o: unknown): MapDoc {
  const d = o as Partial<MapDoc> | null;
  if (!d || typeof d !== 'object' || ![1, 2, 3].includes(d.version as number)) {
    throw new Error('Not a map file (version 1, 2 or 3)');
  }
  if (!Array.isArray(d.features) || !Array.isArray(d.objectives)) throw new Error('Malformed map file');
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  for (const f of d.features) {
    if (!f || !TERRAINS.includes(f.type) || !Array.isArray(f.points) ||
        !f.points.every((p) => Array.isArray(p) && num(p[0]) && num(p[1]))) {
      throw new Error('Malformed feature');
    }
  }
  for (const ob of d.objectives) {
    if (!ob || !num(ob.x) || !num(ob.y)) throw new Error('Malformed objective');
  }
  if (d.background !== undefined && !isHex(d.background)) throw new Error('Bad background colour');
  // v1 -> v2: grid added (on). v2 -> v3: background added (parchment).
  return {
    version: 3,
    title: String(d.title ?? ''),
    rules: String(d.rules ?? ''),
    seed: num(d.seed) ? (d.seed as number) : 1,
    grid: typeof d.grid === 'boolean' ? d.grid : true,
    background: isHex(d.background) ? d.background.toLowerCase() : DEFAULT_BG,
    features: d.features.map((f) => ({ ...f, id: String(f.id ?? uid()) })),
    objectives: d.objectives.map((ob) => ({ ...ob, id: String(ob.id ?? uid()), label: String(ob.label ?? '') })),
  };
}
