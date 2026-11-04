import { describe, expect, it } from 'vitest';
import type { Feature } from './model';
import { featureHitsRect, idsInRect, markerHitsRect, rectOf, segmentHitsRect, type Marker } from './select';

const box = rectOf([100, 100], [50, 60]);  // dragged from bottom-right to top-left: still 50..100 x 60..100
const f = (id: string, type: Feature['type'], points: [number, number][], width?: number): Feature => ({ id, type, points, ...(width ? { width } : {}) });

describe('box select', () => {
  it('normalises the rectangle whichever way it was dragged', () => {
    expect(box).toEqual({ x0: 50, y0: 60, x1: 100, y1: 100 });
  });
  it('segments: crossing, touching a corner, passing outside, parallel', () => {
    expect(segmentHitsRect([0, 80], [200, 80], box)).toBe(true);          // straight through
    expect(segmentHitsRect([0, 0], [200, 200], box)).toBe(true);          // diagonal through (60,60)-(100,100)
    expect(segmentHitsRect([0, 200], [200, 0], box)).toBe(true);          // anti-diagonal through (100,100)? x+y=200 passes the corner
    expect(segmentHitsRect([0, 0], [200, 10], box)).toBe(false);          // well above
    expect(segmentHitsRect([0, 120], [200, 120], box)).toBe(false);       // parallel, below
    expect(segmentHitsRect([60, 0], [60, 55], box)).toBe(false);          // stops short
    expect(segmentHitsRect([60, 0], [60, 65], box)).toBe(true);           // reaches in
  });
  it('a long diagonal wall is selected by crossing it, not by its bounding box', () => {
    const wall = f('w', 'wall', [[0, 0], [300, 300]]);
    expect(featureHitsRect(wall, rectOf([140, 150], [160, 140]))).toBe(true);
    expect(featureHitsRect(wall, rectOf([250, 20], [290, 60]))).toBe(false);   // inside the bbox, far from the wall
  });
  it('lines reach a little to each side (the river is wide)', () => {
    const river = f('r', 'river', [[0, 50], [200, 50]], 10);
    expect(featureHitsRect(river, rectOf([20, 54], [40, 70]))).toBe(true);     // 4 mm off the centre line, river is 5 + 0.6 each side
    expect(featureHitsRect(river, rectOf([20, 60], [40, 70]))).toBe(false);
  });
  it('a filled area is hit by a box inside it, around it or crossing it', () => {
    const hill = f('h', 'hill', [[0, 0], [200, 0], [200, 200], [0, 200]]);
    expect(featureHitsRect(hill, rectOf([80, 80], [90, 90]))).toBe(true);      // wholly inside
    expect(featureHitsRect(hill, rectOf([-50, -50], [300, 300]))).toBe(true);  // around it
    expect(featureHitsRect(hill, rectOf([150, 150], [250, 250]))).toBe(true);  // crossing an edge
    expect(featureHitsRect(hill, rectOf([250, 250], [290, 290]))).toBe(false); // outside
  });
  it('a bridge and a port are pieces between their two ends', () => {
    expect(featureHitsRect(f('b', 'bridge', [[0, 100], [60, 100]]), box)).toBe(true);
    expect(featureHitsRect(f('p', 'port', [[200, 100], [260, 100]]), box)).toBe(false);
  });
  it('an empty piece is never hit', () => {
    expect(featureHitsRect(f('e', 'road', []), box)).toBe(false);
  });
  it('objectives are 5 mm markers', () => {
    expect(markerHitsRect({ x: 75, y: 80 }, box)).toBe(true);     // inside
    expect(markerHitsRect({ x: 104, y: 80 }, box)).toBe(true);    // marker edge overlaps the box
    expect(markerHitsRect({ x: 110, y: 80 }, box)).toBe(false);
  });
  it('collects every id the box touches', () => {
    const feats = [f('in', 'hill', [[60, 70], [90, 70], [80, 95]]), f('out', 'wood', [[300, 10], [330, 10], [320, 40]]), f('line', 'wall', [[0, 80], [200, 80]])];
    const objs: Marker[] = [{ id: 'o1', x: 70, y: 90, label: '1' }, { id: 'o2', x: 400, y: 280, label: '2' }];
    expect(idsInRect(feats, objs, box).sort()).toEqual(['in', 'line', 'o1']);
  });
});
