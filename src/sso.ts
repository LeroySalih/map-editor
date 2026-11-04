// Sign in with DINO (planner-004): Authorization Code + PKCE (S256), straight from the browser. No client secret.
// Same flow as Kerf Sabre (see that repo's docs/AUTH-PLANNER-004.md). The access token (a ~15 minute JWT) lives in memory
// only; the rotating refresh token lives in sessionStorage, so closing the tab signs out. The person's name is kept in memory
// only and is never stored or logged. An email is never asked for.
type Fetch = typeof fetch;

export interface SsoConfig { issuer: string; clientId: string; scope: string }
export interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number }
export interface Person { id: string; roles: string[]; name: string | null }

export class SsoError extends Error {
  /** True when DINO could not be reached at all (retry later), false when it refused. */
  constructor(message: string, readonly offline = false) { super(message); }
}

export function defaultConfig(): SsoConfig {
  const env = import.meta.env ?? {};
  return {
    issuer: (env.VITE_DINO_ISSUER ?? 'https://dino.mr-salih.org').replace(/\/+$/, ''),
    clientId: env.VITE_DINO_CLIENT_ID ?? 'map-editor',
    scope: 'profile',
  };
}

const endpoint = (cfg: SsoConfig, name: 'authorize' | 'token' | 'revoke' | 'userinfo') => `${cfg.issuer}/oauth/${name}`;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomString = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const pkceChallenge = async (verifier: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** This page's own address without any query: the redirect URI that must be registered with DINO. */
export const redirectUriFor = (loc: { origin: string; pathname: string }): string => loc.origin + loc.pathname;

export function buildAuthorizeUrl(a: { cfg: SsoConfig; redirectUri: string; challenge: string; state: string }): string {
  const u = new URL(endpoint(a.cfg, 'authorize'));
  const p = u.searchParams;
  p.set('response_type', 'code'); p.set('client_id', a.cfg.clientId); p.set('redirect_uri', a.redirectUri);
  p.set('code_challenge', a.challenge); p.set('code_challenge_method', 'S256'); p.set('state', a.state);
  if (a.cfg.scope) p.set('scope', a.cfg.scope);
  return u.toString();
}

export type Callback = { code: string; state: string } | { error: string; description: string } | null;
/** What DINO sent the browser back with, or null for an ordinary page load. */
export function readCallback(search: string): Callback {
  const p = new URLSearchParams(search);
  if (p.get('error')) return { error: p.get('error')!, description: p.get('error_description') ?? '' };
  const code = p.get('code'), state = p.get('state');
  return code && state ? { code, state } : null;
}

const PENDING = 'map-editor.sso.pending';
const SAVED = 'map-editor.sso.refresh';
const read = <T>(st: Storage, k: string): T | null => { try { return JSON.parse(st.getItem(k) ?? 'null') as T | null; } catch { return null; } };
const write = (st: Storage, k: string, v: unknown | null): void => {
  try { if (v === null) st.removeItem(k); else st.setItem(k, JSON.stringify(v)); } catch { /* private window: signed in for this page only */ }
};

/** Send the browser to DINO. It comes back to this same page with ?code=&state=. */
export async function beginSignIn(cfg: SsoConfig, loc: { origin: string; pathname: string }, go: (url: string) => void, st: Storage = sessionStorage): Promise<void> {
  const verifier = randomString(48), state = randomString(24);
  write(st, PENDING, { verifier, state });
  go(buildAuthorizeUrl({ cfg, redirectUri: redirectUriFor(loc), challenge: await pkceChallenge(verifier), state }));
}

function tokensFrom(j: Record<string, unknown>, now: number, keepRefresh: string | null): Tokens {
  if (typeof j.access_token !== 'string') throw new SsoError('DINO did not send a sign-in token.');
  const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : keepRefresh;
  return { accessToken: j.access_token, refreshToken: refresh, expiresAt: now + (typeof j.expires_in === 'number' ? j.expires_in : 900) * 1000 };
}

async function tokenRequest(cfg: SsoConfig, form: Record<string, string>, f: Fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(endpoint(cfg, 'token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  } catch { throw new SsoError("Can't reach DINO to sign you in. Check your network.", true); }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new SsoError(typeof j.error_description === 'string' ? j.error_description : 'DINO refused the sign-in. Try again.');
  return j;
}

/** Who this is. Display only: the name comes from DINO's userinfo (scope `profile`) and is never stored. */
export async function fetchPerson(cfg: SsoConfig, accessToken: string, f: Fetch = fetch): Promise<Person> {
  try {
    const res = await f(endpoint(cfg, 'userinfo'), { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } });
    if (res.ok) {
      const j = (await res.json()) as Record<string, unknown>;
      if (typeof j.sub === 'string') {
        return {
          id: j.sub,
          roles: Array.isArray(j.roles) ? j.roles.filter((r): r is string => typeof r === 'string') : [],
          name: typeof j.name === 'string' && j.name.trim() && !j.name.includes('@') ? j.name.trim().slice(0, 128) : null,
        };
      }
    }
  } catch { /* fall through to the token's own claims */ }
  // DINO could not say: read the ID and roles from the token itself (display only, not verified here).
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return {
      id: String(payload.sub ?? ''),
      roles: Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === 'string') : [],
      name: null,
    };
  } catch { return { id: '', roles: [], name: null }; }
}

/** Called on the page DINO returned to. Null when this is not a sign-in return. Throws SsoError with a readable message. */
export async function finishSignIn(cfg: SsoConfig, search: string, loc: { origin: string; pathname: string }, f: Fetch = fetch, st: Storage = sessionStorage, now = Date.now()): Promise<{ tokens: Tokens; person: Person } | null> {
  const cb = readCallback(search);
  if (!cb) return null;
  const pending = read<{ verifier: string; state: string }>(st, PENDING);
  write(st, PENDING, null); // a sign-in attempt is used once
  if ('error' in cb) throw new SsoError(cb.error === 'access_denied' ? 'Sign-in was cancelled.' : `DINO would not sign you in${cb.description ? `: ${cb.description}` : '.'}`);
  if (!pending || pending.state !== cb.state) throw new SsoError('That sign-in did not start here, or it took too long. Start again.');
  const tokens = tokensFrom(await tokenRequest(cfg, {
    grant_type: 'authorization_code', code: cb.code, client_id: cfg.clientId,
    redirect_uri: redirectUriFor(loc), code_verifier: pending.verifier,
  }, f), now, null);
  if (tokens.refreshToken) write(st, SAVED, { refreshToken: tokens.refreshToken });
  return { tokens, person: await fetchPerson(cfg, tokens.accessToken, f) };
}

/** Trade the refresh token for new tokens (rotating it). Null when there is none or DINO refuses it. Throws SsoError(offline) when DINO cannot be reached. */
export async function refreshTokens(cfg: SsoConfig, f: Fetch = fetch, st: Storage = sessionStorage, now = Date.now()): Promise<Tokens | null> {
  const saved = read<{ refreshToken: string }>(st, SAVED);
  if (!saved) return null;
  try {
    const t = tokensFrom(await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: cfg.clientId }, f), now, saved.refreshToken);
    write(st, SAVED, { refreshToken: t.refreshToken ?? saved.refreshToken });
    return t;
  } catch (e) {
    if (e instanceof SsoError && e.offline) throw e;
    write(st, SAVED, null);
    return null;
  }
}

/** After a page reload: a fresh session from this tab's refresh token, or null. */
export async function restoreSignIn(cfg: SsoConfig, f: Fetch = fetch, st: Storage = sessionStorage, now = Date.now()): Promise<{ tokens: Tokens; person: Person } | null> {
  const tokens = await refreshTokens(cfg, f, st, now);
  return tokens ? { tokens, person: await fetchPerson(cfg, tokens.accessToken, f) } : null;
}

/** Sign out: tell DINO to end this connection (best effort) and forget it here. */
export async function endSignIn(cfg: SsoConfig, f: Fetch = fetch, st: Storage = sessionStorage): Promise<void> {
  const saved = read<{ refreshToken: string }>(st, SAVED);
  write(st, SAVED, null);
  if (!saved) return;
  try {
    await f(endpoint(cfg, 'revoke'), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: cfg.clientId }).toString(),
    });
  } catch { /* offline: it expires */ }
}

/** Remove ?code=&state= from the address bar after a sign-in return. */
export const cleanAddress = (): void => { try { history.replaceState(null, '', location.pathname); } catch { /* fine */ } };
