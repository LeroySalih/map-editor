import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl, beginSignIn, endSignIn, fetchPerson, finishSignIn, pkceChallenge, readCallback,
  redirectUriFor, refreshTokens, restoreSignIn, SsoError, type SsoConfig,
} from './sso';

const cfg: SsoConfig = { issuer: 'https://dino.test', clientId: 'map-editor', scope: 'profile' };
const loc = { origin: 'https://maps.test', pathname: '/' };

function store(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

/** A fake DINO: token and userinfo endpoints. */
function fakeDino(opts: { name?: string | null; userinfoFails?: boolean } = {}) {
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.endsWith('/oauth/token')) {
      return json({ access_token: jwt({ sub: 'u_123', roles: ['pupil'] }), refresh_token: 'r1', expires_in: 900 });
    }
    if (url.endsWith('/oauth/userinfo')) {
      if (opts.userinfoFails) return json({}, 401);
      return json({ sub: 'u_123', roles: ['pupil'], ...(opts.name === null ? {} : { name: opts.name ?? 'Ada L' }) });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('DINO sign-in', () => {
  it('builds a PKCE S256 authorize URL for the page itself', async () => {
    const st = store();
    let went = '';
    await beginSignIn(cfg, loc, (u) => { went = u; }, st);
    const u = new URL(went);
    expect(u.origin + u.pathname).toBe('https://dino.test/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('map-editor');
    expect(u.searchParams.get('redirect_uri')).toBe('https://maps.test/');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('profile');
    const saved = JSON.parse(st.getItem('map-editor.sso.pending')!);
    expect(u.searchParams.get('code_challenge')).toBe(await pkceChallenge(saved.verifier));
    expect(u.searchParams.get('state')).toBe(saved.state);
  });

  it('matches the RFC 7636 PKCE example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('reads callbacks', () => {
    expect(readCallback('')).toBeNull();
    expect(readCallback('?code=c&state=s')).toEqual({ code: 'c', state: 's' });
    expect(readCallback('?error=access_denied')).toMatchObject({ error: 'access_denied' });
    expect(redirectUriFor({ origin: 'http://localhost:5173', pathname: '/' })).toBe('http://localhost:5173/');
    expect(buildAuthorizeUrl({ cfg, redirectUri: 'x', challenge: 'c', state: 's' })).toContain('response_type=code');
  });

  it('finishes a sign-in: checks state, exchanges the code, keeps the refresh token', async () => {
    const st = store(); const { f, calls } = fakeDino();
    await beginSignIn(cfg, loc, () => {}, st);
    const { state, verifier } = JSON.parse(st.getItem('map-editor.sso.pending')!);
    const r = await finishSignIn(cfg, `?code=abc&state=${state}`, loc, f, st, 1_000);
    expect(r!.person).toEqual({ id: 'u_123', roles: ['pupil'], name: 'Ada L' });
    expect(r!.tokens.expiresAt).toBe(1_000 + 900_000);
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe(verifier);
    expect(form.get('client_id')).toBe('map-editor');
    expect(st.getItem('map-editor.sso.pending')).toBeNull();
    expect(JSON.parse(st.getItem('map-editor.sso.refresh')!)).toEqual({ refreshToken: 'r1' });
  });

  it('refuses a wrong state, a missing attempt and a cancel, without calling DINO', async () => {
    const st = store(); const { f, calls } = fakeDino();
    await beginSignIn(cfg, loc, () => {}, st);
    await expect(finishSignIn(cfg, '?code=abc&state=WRONG', loc, f, st)).rejects.toThrow(/did not start here/);
    await expect(finishSignIn(cfg, '?code=abc&state=WRONG', loc, f, st)).rejects.toThrow(/did not start here/);
    await expect(finishSignIn(cfg, '?error=access_denied', loc, f, st)).rejects.toThrow(/cancelled/);
    expect(calls.length).toBe(0);
    expect(await finishSignIn(cfg, '', loc, f, st)).toBeNull();
  });

  it('never keeps an email-looking name, and falls back to the token when userinfo fails', async () => {
    const t = jwt({ sub: 'u_9', roles: ['teacher'] });
    expect((await fetchPerson(cfg, t, fakeDino({ name: 'a@b.c' }).f)).name).toBeNull();
    expect(await fetchPerson(cfg, t, fakeDino({ userinfoFails: true }).f)).toEqual({ id: 'u_9', roles: ['teacher'], name: null });
  });

  it('restores from the refresh token, rotating it, and drops it when DINO refuses', async () => {
    const st = store(); const { f } = fakeDino();
    expect(await restoreSignIn(cfg, f, st)).toBeNull();
    st.setItem('map-editor.sso.refresh', JSON.stringify({ refreshToken: 'old' }));
    expect((await restoreSignIn(cfg, f, st))!.person.id).toBe('u_123');
    expect(JSON.parse(st.getItem('map-editor.sso.refresh')!)).toEqual({ refreshToken: 'r1' });
    const refuse = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    expect(await refreshTokens(cfg, refuse, st)).toBeNull();
    expect(st.getItem('map-editor.sso.refresh')).toBeNull();
  });

  it('keeps the refresh token and reports offline when DINO cannot be reached', async () => {
    const st = store();
    st.setItem('map-editor.sso.refresh', JSON.stringify({ refreshToken: 'keep' }));
    const down = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    await expect(refreshTokens(cfg, down, st)).rejects.toMatchObject({ offline: true });
    expect(st.getItem('map-editor.sso.refresh')).not.toBeNull();
    expect(new SsoError('x').offline).toBe(false);
  });

  it('signs out: revokes the refresh token and forgets it', async () => {
    const st = store(); const { f, calls } = fakeDino();
    st.setItem('map-editor.sso.refresh', JSON.stringify({ refreshToken: 'r1' }));
    await endSignIn(cfg, f, st);
    expect(calls[0].url).toBe('https://dino.test/oauth/revoke');
    expect(new URLSearchParams(calls[0].body).get('token')).toBe('r1');
    expect(st.getItem('map-editor.sso.refresh')).toBeNull();
  });
});
