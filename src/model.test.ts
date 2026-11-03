import { describe, expect, it } from 'vitest';
import { genMap } from './generate';
import { newDoc, validate } from './model';
import { renderSvg } from './render';

describe('map model', () => {
  it('round-trips through validate', () => {
    const d = newDoc();
    d.features = genMap(7);
    expect(validate(JSON.parse(JSON.stringify(d))).features.length).toBe(d.features.length);
  });
  it('rejects bad files', () => {
    expect(() => validate({ version: 2 })).toThrow();
    expect(() => validate({ version: 1, features: [{ type: 'lava', points: [] }], objectives: [] })).toThrow();
  });
  it('generation is deterministic per seed', () => {
    const strip = (s: ReturnType<typeof genMap>) => s.map((f) => ({ ...f, id: '' }));
    expect(strip(genMap(3))).toEqual(strip(genMap(3)));
  });
  it('escapes text in the SVG', () => {
    const d = newDoc();
    d.title = '<script>';
    expect(renderSvg(d)).not.toContain('<script>');
  });
});
