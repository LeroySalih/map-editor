import { describe, expect, it } from 'vitest';
import { ApiError, createMap, deleteMap, listMaps, openMap, saveMap } from './api';

const reply = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
function fake(res: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch;
  return { f, calls };
}

describe('map server client', () => {
  it('sends the token and reads the list', async () => {
    const { f, calls } = fake(reply([{ id: 'a', title: 'T', version: 1, updatedAt: 'x' }]));
    expect((await listMaps('tok', f))[0].id).toBe('a');
    expect(calls[0].url).toBe('/api/v1/maps');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('creates, saves with the base version, opens and deletes', async () => {
    let r = fake(reply({ id: 'a', version: 1, updatedAt: 'x' }, 201));
    await createMap('t', { v: 1 }, r.f);
    expect(r.calls[0].init.method).toBe('POST');
    expect(JSON.parse(r.calls[0].init.body as string)).toEqual({ doc: { v: 1 } });
    r = fake(reply({ id: 'a', version: 3, updatedAt: 'x' }));
    await saveMap('t', 'a', { v: 1 }, 2, r.f);
    expect(r.calls[0].url).toBe('/api/v1/maps/a');
    expect(JSON.parse(r.calls[0].init.body as string)).toEqual({ doc: { v: 1 }, baseVersion: 2 });
    r = fake(reply({ id: 'a/b', title: 't', version: 1, updatedAt: 'x', doc: {} }));
    await openMap('t', 'a/b', r.f);
    expect(r.calls[0].url).toBe('/api/v1/maps/a%2Fb');
    r = fake(reply(null, 204));
    await expect(deleteMap('t', 'a', r.f)).resolves.toBeUndefined();
  });
  it('turns server errors into readable ApiErrors', async () => {
    const r = fake(reply({ error: { code: 'conflict', message: 'Changed elsewhere.' } }, 409));
    await expect(saveMap('t', 'a', {}, 1, r.f)).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'Changed elsewhere.' });
    await expect(listMaps('t', fake(reply('nope' as unknown as object, 502)).f)).rejects.toBeInstanceOf(ApiError);
  });
  it('reports an unreachable server', async () => {
    await expect(listMaps('t', fake(new TypeError('net')).f)).rejects.toMatchObject({ status: 0, code: 'offline' });
  });
});
