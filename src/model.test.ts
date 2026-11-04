import { describe, expect, it } from 'vitest';
import { genMap } from './generate';
import { newDoc, validate } from './model';
import { hexGridPath, lineColourFor, luminance, renderSvg } from './render';

describe('map model', () => {
  it('round-trips through validate', () => {
    const d = newDoc();
    d.features = genMap(7);
    expect(validate(JSON.parse(JSON.stringify(d))).features.length).toBe(d.features.length);
  });
  it('rejects bad files', () => {
    expect(() => validate({ version: 4 })).toThrow();
    expect(() => validate({ version: 1, features: [{ type: 'lava', points: [] }], objectives: [] })).toThrow();
  });
  it('generation is deterministic per seed', () => {
    const strip = (s: ReturnType<typeof genMap>) => s.map((f) => ({ ...f, id: '' }));
    expect(strip(genMap(3))).toEqual(strip(genMap(3)));
  });
  it('migrates v1 files with the grid on', () => {
    const v1 = { version: 1, title: 't', rules: '', seed: 1, features: [], objectives: [] };
    const d = validate(v1);
    expect(d.version).toBe(3);
    expect(d.grid).toBe(true);
    expect(d.background).toBe('#e9dfc7');
  });
  it('keeps a valid background colour and refuses a bad one', () => {
    const d = newDoc();
    d.background = '#10203A';
    const back = validate(JSON.parse(JSON.stringify(d)));
    expect(back.background).toBe('#10203a');
    expect(renderSvg(back)).toContain('fill="#10203a"');
    expect(() => validate({ ...d, background: 'red' })).toThrow();
    expect(() => validate({ ...d, background: '#fff"/><script>' })).toThrow();
  });
  it('never puts an untrusted colour into the SVG', () => {
    const d = newDoc();
    d.background = '"/><script>alert(1)</script>';
    const svg = renderSvg(d);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('fill="#e9dfc7"');
  });
  it('uses light linework on a dark sheet and dark linework on a light one', () => {
    expect(luminance('#000000')).toBeCloseTo(0, 5);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
    expect(lineColourFor('#e9dfc7')).toBe('#1c1a17');
    expect(lineColourFor('#ffffff')).toBe('#1c1a17');
    expect(lineColourFor('#1b2a3c')).toBe('#e9dfc7');
    expect(lineColourFor('#000000')).toBe('#e9dfc7');
    const d = newDoc();
    d.background = '#1b2a3c';
    const svg = renderSvg(d);
    expect(svg).toMatch(/<rect x="14" y="14" width="392" height="9" fill="#e9dfc7"\/>/); // title bar is light
    expect(svg).toMatch(/font-size="7" fill="#1b2a3c"/); // its text takes the sheet colour
  });
  it('v2 files load with the default background', () => {
    const v2 = { version: 2, title: 't', rules: '', seed: 1, grid: false, features: [], objectives: [] };
    expect(validate(v2)).toMatchObject({ version: 3, grid: false, background: '#e9dfc7' });
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
  it('draws a wall through many points with straight segments', () => {
    const d = newDoc();
    d.features.push({ id: 'w', type: 'wall', points: [[50, 50], [100, 50], [100, 100], [60, 120]] });
    const svg = renderSvg(d);
    expect(svg).toContain('M50.00,50.00L100.00,50.00L100.00,100.00L60.00,120.00');
    expect(svg).not.toMatch(/data-id="w"[^>]*>(?:(?!<\/g>).)*C\d/);
  });
  it('skips zero-length straight pieces', () => {
    const d = newDoc();
    d.features.push({ id: 'z', type: 'bridge', points: [[10, 10], [10, 10]] });
    expect(renderSvg(d)).not.toContain('data-id="z"');
  });
  it('gives each objective marker a data-obj id and a larger click target', () => {
    const d = newDoc();
    d.objectives.push({ id: 'ob1', x: 100, y: 100, label: '1' });
    const svg = renderSvg(d);
    expect(svg).toContain('data-obj="ob1"');
    expect(svg).toMatch(/<circle cx="100" cy="100" r="9" fill="transparent"\/><\/g>/);
  });
  it('escapes text in the SVG', () => {
    const d = newDoc();
    d.title = '<script>';
    expect(renderSvg(d)).not.toContain('<script>');
  });
});
