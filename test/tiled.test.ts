import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMap } from '../src/shared/map.js';
import { convertTiledMap } from '../src/tools/tiled.js';

const hills = JSON.parse(readFileSync(new URL('./fixtures/hills.tmj', import.meta.url), 'utf8'));

describe('convertTiledMap', () => {
  const map = convertTiledMap(hills, 'hills');

  it('turns each polyline segment into a foothold and skips vertical ones', () => {
    expect(map.footholds).toEqual([
      { id: 1, x1: 0, y1: 500, x2: 300, y2: 500 },
      { id: 2, x1: 300, y1: 500, x2: 500, y2: 420 },
      { id: 3, x1: 700, y1: 300, x2: 900, y2: 300 },
    ]);
  });

  it('reads vertical polylines in the ropes layer as ropes', () => {
    expect(map.ropes).toEqual([{ id: 1, x: 800, y1: 300, y2: 500 }]);
  });

  it('links the segments of one polyline', () => {
    const game = loadMap(map);
    expect(game.footholds.get(1)!.next).toBe(2);
    expect(game.footholds.get(3)!.prev).toBe(0);
  });

  it('uses the map size as bounds and finds the spawn inside group layers', () => {
    expect(map).toMatchObject({ left: 0, right: 1280, bottom: 640, spawn: { x: 110, y: 405 } });
  });

  it('falls back to the first foothold when there is no spawn', () => {
    const noSpawn = { ...hills, layers: [hills.layers[0]] };
    expect(convertTiledMap(noSpawn, 'x').spawn).toEqual({ x: 0, y: 499 });
  });

  /** An object layer of one segment polylines from (x, y) to (x, y) + d, rotated around (x, y). */
  const layerOf = (
    name: string,
    lines: { x: number; y: number; d: number[]; rotation: number }[],
  ) => ({
    type: 'objectgroup',
    name,
    objects: lines.map(({ x, y, d, rotation }, i) => ({
      id: i + 1,
      name: '',
      x,
      y,
      rotation,
      polyline: [
        { x: 0, y: 0 },
        { x: d[0]!, y: d[1]! },
      ],
    })),
  });

  it('rotates objects around their position', () => {
    const tiled = {
      ...hills,
      layers: [
        layerOf('footholds', [
          { x: 0, y: 600, d: [100, 0], rotation: 0 },
          // Turned into a vertical line, skipped.
          { x: 400, y: 300, d: [300, 0], rotation: 90 },
          // A 30 degree slope going down to the right.
          { x: 100, y: 500, d: [200, 0], rotation: 30 },
        ]),
        layerOf('ropes', [
          { x: 800, y: 300, d: [200, 0], rotation: 90 },
          // Turned into a horizontal line, skipped.
          { x: 900, y: 300, d: [0, 200], rotation: -90 },
        ]),
      ],
    };
    const map = convertTiledMap(tiled, 'r');
    expect(map.footholds).toEqual([
      { id: 1, x1: 0, y1: 600, x2: 100, y2: 600 },
      { id: 2, x1: 100, y1: 500, x2: 273.21, y2: 600 },
    ]);
    expect(map.ropes).toEqual([{ id: 1, x: 800, y1: 300, y2: 500 }]);
  });

  it('skips hidden layers and everything inside hidden groups', () => {
    const tiled = {
      ...hills,
      layers: [
        { ...hills.layers[0], visible: true },
        { ...hills.layers[1], visible: false },
        { ...hills.layers[2], visible: false },
      ],
    };
    const map = convertTiledMap(tiled, 'h');
    expect(map.ropes).toBeUndefined();
    expect(map.spawn).toEqual({ x: 0, y: 499 });
    expect(() =>
      convertTiledMap({ ...hills, layers: [{ ...hills.layers[0], visible: false }] }, 'h'),
    ).toThrow(/no object layer named 'footholds'/);
  });

  it('reads ropes from another layer when asked', () => {
    const tiled = { ...hills, layers: [hills.layers[0], { ...hills.layers[1], name: 'ladders' }] };
    expect(convertTiledMap(tiled, 'l').ropes).toBeUndefined();
    expect(convertTiledMap(tiled, 'l', { ropeLayer: 'ladders' }).ropes).toHaveLength(1);
  });

  it('reports a missing layer', () => {
    expect(() => convertTiledMap(hills, 'x', { footholdLayer: 'ground' })).toThrow(
      /no object layer named 'ground'/,
    );
  });
});
