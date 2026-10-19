import { describe, expect, it } from 'vitest';
import { loadMap, type MapData } from '../src/shared/map.js';
import { Button, spawnPlayer, step, type PlayerState } from '../src/shared/physics.js';

const data: MapData = {
  name: 'test',
  left: 0,
  right: 1000,
  bottom: 800,
  spawn: { x: 100, y: 500 },
  footholds: [
    { id: 1, x1: 0, y1: 500, x2: 300, y2: 500 },
    { id: 2, x1: 300, y1: 500, x2: 500, y2: 400 },
    { id: 3, x1: 50, y1: 420, x2: 200, y2: 420 },
    { id: 4, x1: 600, y1: 500, x2: 800, y2: 500 },
  ],
};
const map = loadMap(data);

function run(s: PlayerState, buttons: number, ticks: number): PlayerState {
  for (let i = 0; i < ticks; i++) s = step(map, s, buttons);
  return s;
}

function grounded(x: number, foothold: number): PlayerState {
  const s = run({ ...spawnPlayer(map), x, y: 0 }, 0, 60);
  expect(s.foothold).toBe(foothold);
  return s;
}

describe('loadMap', () => {
  it('links footholds whose endpoints touch', () => {
    expect(map.footholds.get(1)!.next).toBe(2);
    expect(map.footholds.get(2)!.prev).toBe(1);
    expect(map.footholds.get(2)!.next).toBe(0);
    expect(map.footholds.get(4)!.prev).toBe(0);
  });

  it('rejects reversed segments and duplicate ids', () => {
    expect(() => loadMap({ ...data, footholds: [{ id: 1, x1: 5, y1: 0, x2: 1, y2: 0 }] })).toThrow(
      /x2 must be greater/,
    );
    expect(() =>
      loadMap({ ...data, footholds: [data.footholds[0]!, { ...data.footholds[1]!, id: 1 }] }),
    ).toThrow(/duplicate/);
  });
});

describe('step', () => {
  it('falls and lands on the highest foothold crossed', () => {
    const s = grounded(100, 3);
    expect(s.y).toBe(420);
    expect(s.vy).toBe(0);
  });

  it('lands on the ground when nothing is above it', () => {
    expect(grounded(250, 1).y).toBe(500);
  });

  it('walks across a linked foothold and follows the slope', () => {
    let s = grounded(280, 1);
    s = run(s, Button.Right, 10);
    expect(s.foothold).toBe(2);
    expect(s.y).toBeLessThan(500);
    expect(s.y).toBeCloseTo(500 - (s.x - 300) / 2, 3);
  });

  it('falls off an unlinked end', () => {
    let s = grounded(480, 2);
    s = run(s, Button.Right, 10);
    expect(s.foothold).toBe(0);
    expect(s.x).toBeGreaterThan(500);
  });

  it('jumps through a platform from below and lands on it', () => {
    let s: PlayerState = { ...spawnPlayer(map), x: 120, y: 500, foothold: 1 };
    s = step(map, s, Button.Jump);
    expect(s.vy).toBeLessThan(0);
    s = run(s, 0, 60);
    expect(s.foothold).toBe(3);
  });

  it('needs a fresh press to jump again', () => {
    let s = grounded(250, 1);
    s = run(s, Button.Jump, 60);
    expect(s.foothold).toBe(1);
    s = step(map, s, Button.Jump);
    expect(s.foothold).toBe(1);
    s = step(map, s, 0);
    s = step(map, s, Button.Jump);
    expect(s.foothold).toBe(0);
  });

  it('drops through a platform with down + jump', () => {
    let s = grounded(100, 3);
    s = step(map, s, Button.Down | Button.Jump);
    expect(s.foothold).toBe(0);
    s = run(s, 0, 60);
    expect(s.foothold).toBe(1);
  });

  it('respawns after falling out of the map', () => {
    let s = grounded(700, 4);
    s = run(s, Button.Right, 200);
    expect(s.x).toBeLessThanOrEqual(data.right);
    s = { ...s, foothold: 0, x: 900, y: 700 };
    s = run(s, 0, 30);
    expect(s.x).toBe(data.spawn.x);
  });

  it('is deterministic for the same inputs', () => {
    const inputs = Array.from({ length: 300 }, (_, i) => (i * 7919) % 16);
    let a = spawnPlayer(map);
    let b = spawnPlayer(map);
    for (const buttons of inputs) {
      a = step(map, a, buttons);
      b = step(map, b, buttons);
    }
    expect(a).toEqual(b);
  });

  it('keeps every value representable as f32', () => {
    let s = spawnPlayer(map);
    for (let i = 0; i < 200; i++) {
      s = step(map, s, i % 3 ? Button.Right : Button.Jump);
      for (const v of [s.x, s.y, s.vx, s.vy]) expect(Math.fround(v)).toBe(v);
    }
  });
});
