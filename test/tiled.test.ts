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

  it('reports a missing layer', () => {
    expect(() => convertTiledMap(hills, 'x', { footholdLayer: 'ground' })).toThrow(
      /no object layer named 'ground'/,
    );
  });
});
