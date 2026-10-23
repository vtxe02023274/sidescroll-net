import { describe, expect, it } from 'vitest';
import { loadMap, type MapData } from '../src/shared/map.js';
import { applyHit, Button, spawnPlayer, step, type PlayerState } from '../src/shared/physics.js';

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

  it('rejects ids that do not fit the wire or clash with 0', () => {
    const fh = data.footholds[0]!;
    for (const id of [0, -1, 1.5, 65536, 70000, NaN]) {
      expect(() => loadMap({ ...data, footholds: [{ ...fh, id }] })).toThrow(/id must be/);
      expect(() => loadMap({ ...data, ropes: [{ id, x: 0, y1: 0, y2: 5 }] })).toThrow(/id must be/);
    }
    expect(loadMap({ ...data, footholds: [{ ...fh, id: 65535 }] }).footholds.has(65535)).toBe(true);
  });

  it('rejects missing or non numeric coordinates', () => {
    const fh = data.footholds[0]!;
    const bad = [
      { ...fh, y1: '500' },
      { ...fh, y2: undefined },
      { ...fh, x1: Infinity },
    ] as unknown as MapData['footholds'];
    for (const f of bad) {
      expect(() => loadMap({ ...data, footholds: [f] })).toThrow(/must be a finite number/);
    }
    expect(() => loadMap({ ...data, ropes: [{ id: 1, x: NaN, y1: 0, y2: 5 }] })).toThrow(
      /must be a finite number/,
    );
    expect(() => loadMap({ ...data, bottom: '800' as unknown as number })).toThrow(
      /bottom must be a finite number/,
    );
  });

  it('rejects inverted bounds and a spawn outside them', () => {
    expect(() => loadMap({ ...data, left: 1000, right: 0 })).toThrow(/left must be less/);
    expect(() => loadMap({ ...data, spawn: { x: 100, y: 900 } })).toThrow(/spawn/);
    expect(() => loadMap({ ...data, spawn: { x: -5, y: 500 } })).toThrow(/spawn/);
    expect(() => loadMap({ ...data, spawn: { x: 1001, y: 500 } })).toThrow(/spawn/);
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

describe('ropes', () => {
  const roped = loadMap({
    ...data,
    footholds: [...data.footholds, { id: 5, x1: 380, y1: 300, x2: 480, y2: 300 }],
    ropes: [{ id: 1, x: 400, y1: 300, y2: 500 }],
  });
  const at = (x: number, y: number, foothold = 0): PlayerState => ({
    ...spawnPlayer(roped),
    x,
    y,
    foothold,
  });
  const go = (s: PlayerState, buttons: number, ticks: number) => {
    for (let i = 0; i < ticks; i++) s = step(roped, s, buttons);
    return s;
  };

  it('grabs a rope from the ground with up and climbs to the platform on top', () => {
    let s = at(395, 500, 1);
    s = step(roped, s, Button.Up);
    expect(s.rope).toBe(1);
    expect(s.x).toBe(400);
    s = go(s, Button.Up, 80);
    expect(s.rope).toBe(0);
    expect(s.foothold).toBe(5);
    expect(s.y).toBe(300);
  });

  it('knocks a player off the rope when hit and keeps them off while hurt', () => {
    let s = at(395, 500, 1);
    s = go(s, Button.Up, 5);
    expect(s.rope).toBe(1);
    s = applyHit(s, 1);
    s = step(roped, s, Button.Up);
    expect(s.rope).toBe(0);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.vy).toBeLessThan(0);
    s = go(s, Button.Up, 5);
    expect(s.rope).toBe(0);
  });

  it('climbs down from the top with down and lets go at the bottom', () => {
    let s = at(402, 300, 5);
    s = step(roped, s, Button.Down);
    expect(s.rope).toBe(1);
    s = go(s, Button.Down, 70);
    expect(s.rope).toBe(0);
    expect(s.y).toBeGreaterThan(300);
  });

  it('jumps off sideways but not straight up', () => {
    let s = at(400, 400);
    s = step(roped, s, Button.Up);
    expect(s.rope).toBe(1);
    s = step(roped, s, Button.Jump);
    expect(s.rope).toBe(1);
    s = step(roped, s, 0);
    s = step(roped, s, Button.Jump | Button.Right);
    expect(s.rope).toBe(0);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.vy).toBeLessThan(0);
    // Holding up right after jumping off does not grab it again at once.
    s = step(roped, s, Button.Up);
    expect(s.rope).toBe(0);
  });

  it('ignores ropes out of reach', () => {
    const s = step(roped, at(420, 500, 1), Button.Up);
    expect(s.rope).toBe(0);
  });

  it('rejects broken ropes', () => {
    expect(() => loadMap({ ...data, ropes: [{ id: 1, x: 0, y1: 10, y2: 5 }] })).toThrow(/y2 must/);
    expect(() => loadMap({ ...data, ropes: [{ id: 0, x: 0, y1: 0, y2: 5 }] })).toThrow(
      /id must be/,
    );
  });
});
