import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Interpolator, Predictor } from '../src/client/netcode.js';
import { Game, MAX_REWIND_TICKS } from '../src/server/game.js';
import { loadMap, type MapData } from '../src/shared/map.js';
import {
  applyHit,
  Button,
  Physics,
  spawnPlayer,
  step,
  type PlayerState,
} from '../src/shared/physics.js';
import {
  decode,
  DecodeError,
  encode,
  Op,
  setSnapshotAck,
  type SnapshotMessage,
} from '../src/shared/protocol.js';

const map = loadMap(
  JSON.parse(readFileSync(new URL('../maps/field.json', import.meta.url), 'utf8')) as MapData,
);

/** A made up but busy input sequence: walking both ways, jumping, dropping. */
function inputAt(tick: number): number {
  const phase = Math.floor(tick / 45) % 4;
  let b = [Button.Right, Button.Right | Button.Jump, Button.Left, Button.Down | Button.Jump][
    phase
  ]!;
  if (tick % 9 > 5) b &= ~Button.Jump;
  if (tick % 23 === 0) b |= Button.Attack;
  if (tick % 31 < 12) b |= Button.Up;
  return b;
}

describe('protocol', () => {
  it('round trips every message', () => {
    let s = spawnPlayer(map);
    for (let i = 0; i < 40; i++) s = step(map, s, inputAt(i));
    const snapshot: SnapshotMessage = {
      op: Op.Snapshot,
      tick: 123456,
      ackSeq: 99,
      entities: [
        { id: 1, state: s },
        {
          id: 65535,
          state: {
            ...s,
            facing: -1,
            jumpHeld: true,
            dropFoothold: 12,
            dropTicks: 3,
            attackTicks: 7,
            hurtTicks: 9,
            rope: 3,
            ropeCooldown: 4,
          },
        },
      ],
    };
    for (const msg of [
      { op: Op.Input, seq: 4294967295, buttons: 63, viewTick: 77 } as const,
      { op: Op.Welcome, playerId: 7, tickRate: 30 } as const,
      snapshot,
    ]) {
      expect(decode(encode(msg))).toEqual(msg);
    }
  });

  it('rejects truncated and unknown messages', () => {
    const bytes = encode({
      op: Op.Snapshot,
      tick: 1,
      ackSeq: 0,
      entities: [{ id: 1, state: spawnPlayer(map) }],
    });
    expect(() => decode(bytes.subarray(0, bytes.length - 1))).toThrow(DecodeError);
    expect(() => decode(new Uint8Array([]))).toThrow(DecodeError);
    expect(() => decode(new Uint8Array([200]))).toThrow(/unknown opcode/);
  });
});

describe('game', () => {
  it('applies one step per input and acknowledges it', () => {
    const game = new Game(map);
    const id = game.addPlayer();
    game.pushInput(id, 1, Button.Right);
    game.update();
    expect(game.snapshotFor(id).ackSeq).toBe(1);
    expect(game.state(id)).toEqual(step(map, spawnPlayer(map), Button.Right));
  });

  it('ignores stale and duplicate sequence numbers', () => {
    const game = new Game(map);
    const id = game.addPlayer();
    game.pushInput(id, 5, 0);
    game.pushInput(id, 5, Button.Right);
    game.pushInput(id, 3, Button.Right);
    game.update();
    game.update();
    expect(game.snapshotFor(id).ackSeq).toBe(5);
    expect(game.state(id)!.vx).toBe(0);
  });

  it('limits how fast a client can spend inputs', () => {
    const game = new Game(map);
    const id = game.addPlayer();
    for (let seq = 1; seq <= 100; seq++) game.pushInput(id, seq, Button.Right);
    for (let i = 0; i < 10; i++) game.update();
    // Eight inputs fit in the queue and at most one per tick on average is spent.
    expect(game.snapshotFor(id).ackSeq).toBeLessThanOrEqual(8);
    expect(game.snapshotFor(id).ackSeq).toBeGreaterThanOrEqual(7);
  });

  it('includes every player in snapshots', () => {
    const game = new Game(map);
    const a = game.addPlayer();
    const b = game.addPlayer();
    expect(game.snapshotFor(a).entities.map((e) => e.id)).toEqual([a, b]);
    game.removePlayer(a);
    expect(game.snapshotFor(b).entities.map((e) => e.id)).toEqual([b]);
  });
});

describe('prediction', () => {
  it('matches the server exactly under latency', () => {
    const game = new Game(map);
    const id = game.addPlayer();
    const predictor = new Predictor(map);
    predictor.reconcile(spawnPlayer(map), 0);

    const latencyTicks = 6;
    const toServer: { at: number; seq: number; buttons: number }[] = [];
    const toClient: { at: number; bytes: Uint8Array }[] = [];
    let worst = 0;

    for (let tick = 0; tick < 600; tick++) {
      const buttons = inputAt(tick);
      toServer.push({ at: tick + latencyTicks, seq: predictor.apply(buttons), buttons });

      while (toServer[0] && toServer[0].at <= tick) {
        const m = toServer.shift()!;
        game.pushInput(id, m.seq, m.buttons);
      }
      game.update();
      if (tick % 2 === 0)
        toClient.push({ at: tick + latencyTicks, bytes: encode(game.snapshotFor(id)) });

      while (toClient[0] && toClient[0].at <= tick) {
        const msg = decode(toClient.shift()!.bytes) as SnapshotMessage;
        predictor.reconcile(msg.entities.find((e) => e.id === id)!.state, msg.ackSeq);
        worst = Math.max(worst, predictor.lastCorrection);
      }
    }

    expect(worst).toBe(0);
    expect(predictor.pendingCount).toBeGreaterThan(0);
  });
});

describe('interpolation', () => {
  const at = (x: number) => [{ id: 2, state: { ...spawnPlayer(map), x } }];

  it('blends between the snapshots around the render time', () => {
    const interp = new Interpolator(100);
    interp.push(0, at(0));
    interp.push(100, at(10));
    expect(interp.sample(2, 150)!.x).toBe(5);
    expect(interp.sample(2, 50)!.x).toBe(0);
    expect(interp.sample(2, 500)!.x).toBe(10);
  });

  it('forgets players that left', () => {
    const interp = new Interpolator(100);
    interp.push(0, at(0));
    interp.push(100, []);
    expect(interp.ids()).toEqual([]);
  });
});

describe('setSnapshotAck', () => {
  it('only changes the ack', () => {
    const game = new Game(map);
    const a = game.addPlayer();
    game.addPlayer();
    const bytes = encode(game.snapshotFor(a));
    setSnapshotAck(bytes, 77);
    expect(decode(bytes)).toEqual({ ...game.snapshotFor(a), ackSeq: 77 });
  });
});

describe('view', () => {
  it('leaves out players beyond the view but always includes yourself', () => {
    const game = new Game(map, { view: { x: 500, y: 300 } });
    const a = game.addPlayer();
    const b = game.addPlayer();
    const c = game.addPlayer();
    for (let seq = 1; seq <= 200; seq++) {
      game.pushInput(b, seq, Button.Right);
      game.update();
    }
    const far = game.state(b)!.x - game.state(a)!.x;
    expect(far).toBeGreaterThan(500);
    expect(game.snapshotFor(a).entities.map((e) => e.id)).toEqual([a, c]);
    expect(game.snapshotFor(b).entities.map((e) => e.id)).toEqual([b]);
    expect(game.seesWholeMap).toBe(false);
  });
});

describe('lag compensation', () => {
  /** Two players standing on the same spot, so b is inside a's reach. */
  function setup() {
    const game = new Game(map);
    const a = game.addPlayer();
    const b = game.addPlayer();
    const tick = (buttonsA: number, buttonsB: number, viewTick?: number) => {
      seq++;
      game.pushInput(a, seq, buttonsA, viewTick);
      game.pushInput(b, seq, buttonsB);
      game.update();
    };
    let seq = 0;
    for (let i = 0; i < 30; i++) tick(0, 0);
    return { game, a, b, tick };
  }

  it('hits a target where the attacker saw it, not where it is now', () => {
    const { game, a, b, tick } = setup();
    const seenAt = game.tick;
    // b jumps clear of the swing before a's attack reaches the server.
    for (let i = 0; i < 8; i++) tick(0, Button.Jump);
    expect(game.state(a)!.y - game.state(b)!.y).toBeGreaterThan(60);

    tick(Button.Attack, Button.Jump, seenAt);

    expect(game.hits).toEqual([{ attacker: a, target: b, tick: seenAt }]);
    expect(game.state(b)!.hurtTicks).toBe(Physics.hurtTicks);
    expect(game.state(b)!.vx).toBeGreaterThan(0);
  });

  it('misses when the attacker saw the target out of reach', () => {
    const { game, tick } = setup();
    for (let i = 0; i < 8; i++) tick(0, Button.Jump);
    tick(Button.Attack, Button.Jump, game.tick);
    expect(game.hits).toEqual([]);
  });

  it('does not rewind further than the limit', () => {
    const { game, a, b, tick } = setup();
    const seenAt = game.tick;
    for (let i = 0; i < MAX_REWIND_TICKS + 30; i++) tick(0, Button.Right);
    expect(game.state(b)!.x - game.state(a)!.x).toBeGreaterThan(150);
    tick(Button.Attack, 0, seenAt);
    expect(game.hits).toEqual([]);
  });

  it('predicts the attacker swing exactly', () => {
    let s = spawnPlayer(map);
    s = step(map, s, Button.Attack);
    expect(s.attackTicks).toBe(Physics.attackTicks);
    s = run(s, Button.Attack, Physics.attackTicks - 1);
    expect(s.attackTicks).toBe(1);
    s = step(map, s, Button.Attack);
    expect(s.attackTicks).toBe(0);
    s = step(map, s, Button.Attack);
    expect(s.attackTicks).toBe(Physics.attackTicks);
  });

  it('ignores input while knocked back', () => {
    let s = applyHit(spawnPlayer(map), 1);
    s = step(map, s, Button.Left | Button.Attack);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.attackTicks).toBe(0);
  });
});

function run(s: PlayerState, buttons: number, ticks: number): PlayerState {
  for (let i = 0; i < ticks; i++) s = step(map, s, buttons);
  return s;
}
