import { describe, expect, it } from 'vitest';
import { genMap } from './generate';
import { newDoc, validate } from './model';
import { hexGridPath, renderSvg } from './render';

describe('map model', () => {
  it('round-trips through validate', () => {
    const d = newDoc();
    d.features = genMap(7);
    expect(validate(JSON.parse(JSON.stringify(d))).features.length).toBe(d.features.length);
  });
  it('rejects bad files', () => {
    expect(() => validate({ version: 3 })).toThrow();
    expect(() => validate({ version: 1, features: [{ type: 'lava', points: [] }], objectives: [] })).toThrow();
  });
  it('generation is deterministic per seed', () => {
    const strip = (s: ReturnType<typeof genMap>) => s.map((f) => ({ ...f, id: '' }));
    expect(strip(genMap(3))).toEqual(strip(genMap(3)));
  });
  it('migrates v1 files with the grid on', () => {
    const v1 = { version: 1, title: 't', rules: '', seed: 1, features: [], objectives: [] };
    const d = validate(v1);
    expect(d.version).toBe(2);
    expect(d.grid).toBe(true);
  });
  it('draws the hex grid only when enabled', () => {
    const d = newDoc();
    expect(renderSvg(d)).toContain('id="hexgrid"');
    d.grid = false;
    expect(renderSvg(d)).not.toContain('id="hexgrid"');
  });
  it('hex grid has 20 mm flat-to-flat pitch', () => {
    // Row -1 sits one hex above the border (clipped): y = 14 + 10 - 20 - 10 = -6.
    expect(hexGridPath().startsWith('M19.77,-6.00H31.32')).toBe(true);
    // Rows are 20 mm apart: the second hex in column 0 starts 20 mm lower.
    expect(hexGridPath()).toContain('M19.77,14.00H31.32');
  });
  it('draws walls, bridges and ports as straight pieces', () => {
    const d = newDoc();
    for (const type of ['wall', 'bridge', 'port'] as const) {
      d.features.push({ id: type, type, points: [[50, 100], [90, 130]] });
    }
    const svg = renderSvg(d);
    for (const id of ['wall', 'bridge', 'port']) expect(svg).toContain(`data-id="${id}"`);
    expect(validate(JSON.parse(JSON.stringify(d))).features.length).toBe(3);
  });
  it('skips zero-length straight pieces', () => {
    const d = newDoc();
    d.features.push({ id: 'z', type: 'wall', points: [[10, 10], [10, 10]] });
    expect(renderSvg(d)).not.toContain('data-id="z"');
  });
  it('escapes text in the SVG', () => {
    const d = newDoc();
    d.title = '<script>';
    expect(renderSvg(d)).not.toContain('<script>');
  });
});
