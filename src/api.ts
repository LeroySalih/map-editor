// Client for the map server (server/): a signed-in person's own maps. Every call sends the DINO access token.
type Fetch = typeof fetch;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export interface MapSummary { id: string; title: string; version: number; updatedAt: string }
export interface MapRecord extends MapSummary { doc: unknown }
export interface Saved { id: string; version: number; updatedAt: string }

const base = (): string => ((import.meta.env?.VITE_API_URL ?? '') as string).replace(/\/+$/, '') + '/api/v1';

async function call<T>(token: string, method: string, path: string, body?: unknown, f: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(base() + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError("Can't reach the map server. Check your network.", 0, 'offline'); }
  if (res.status === 204) return undefined as T;
  const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    throw new ApiError(j?.error?.message ?? `The map server said ${res.status}.`, res.status, j?.error?.code ?? 'error');
  }
  return j as T;
}

export const listMaps = (token: string, f?: Fetch) => call<MapSummary[]>(token, 'GET', '/maps', undefined, f);
export const openMap = (token: string, id: string, f?: Fetch) => call<MapRecord>(token, 'GET', `/maps/${encodeURIComponent(id)}`, undefined, f);
export const createMap = (token: string, doc: unknown, f?: Fetch) => call<Saved>(token, 'POST', '/maps', { doc }, f);
/** `baseVersion` makes a stale save fail with code `conflict` instead of overwriting someone else's change. */
export const saveMap = (token: string, id: string, doc: unknown, baseVersion: number, f?: Fetch) =>
  call<Saved>(token, 'PUT', `/maps/${encodeURIComponent(id)}`, { doc, baseVersion }, f);
export const deleteMap = (token: string, id: string, f?: Fetch) => call<void>(token, 'DELETE', `/maps/${encodeURIComponent(id)}`, undefined, f);
