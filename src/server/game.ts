import type { GameMap } from '../shared/map.js';
import {
  applyHit,
  attackStarted,
  Physics,
  spawnPlayer,
  step,
  TICK_RATE,
  type PlayerState,
} from '../shared/physics.js';
import type { SnapshotMessage } from '../shared/protocol.js';

/** Inputs a client may bank up. Anything beyond this is dropped, which caps speed hacks. */
const MAX_QUEUED_INPUTS = 8;
/** Inputs applied per player per tick when catching up after a lag spike. */
const MAX_INPUTS_PER_TICK = 2;
/**
 * How far back a hit check may rewind. Clients see others in the past by
 * their latency plus the interpolation delay; this caps how much a laggy
 * client is trusted.
 */
export const MAX_REWIND_TICKS = 15;

/** Reach of a swing in front of the attacker, and a little behind. */
const ATTACK_BOX = { front: 70, back: 10, up: 50, down: 5 };
/** Player body around its feet position. */
const BODY = { halfWidth: 12, height: 40 };

interface Player {
  id: number;
  state: PlayerState;
  queue: { seq: number; buttons: number; viewTick: number }[];
  ackSeq: number;
  /** Inputs the player may still spend; refilled by one each tick. */
  budget: number;
  /** Positions at the end of recent ticks, newest last, for rewinding hit checks. */
  history: { tick: number; x: number; y: number }[];
  /**
   * Server tick from which the player can be hit again. Counted in server
   * ticks, not in the hurtTicks of its state, which only run down when the
   * client sends input: a client that goes quiet after a hit stays hittable.
   */
  hittableAt: number;
}

export interface Hit {
  attacker: number;
  target: number;
  /** Tick the target was rewound to. */
  tick: number;
}

export interface GameOptions {
  /**
   * Half size of the area around a player that its snapshots cover. Players
   * outside it are left out, which keeps bandwidth linear instead of
   * quadratic on big maps. Defaults to the whole map.
   */
  view?: { x: number; y: number };
}

/**
 * Authoritative game state. It knows nothing about sockets so it can be
 * driven by tests one tick at a time.
 */
export class Game {
  readonly tickRate = TICK_RATE;
  tick = 0;
  private readonly players = new Map<number, Player>();
  private nextId = 1;
  /** Hits resolved in the last update. */
  hits: Hit[] = [];

  private readonly view: { x: number; y: number };

  constructor(
    readonly map: GameMap,
    options: GameOptions = {},
  ) {
    this.view = options.view ?? { x: Infinity, y: Infinity };
  }

  addPlayer(): number {
    const id = this.nextId++;
    this.players.set(id, {
      id,
      state: spawnPlayer(this.map),
      queue: [],
      ackSeq: 0,
      budget: MAX_INPUTS_PER_TICK,
      history: [],
      hittableAt: 0,
    });
    return id;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  get playerCount(): number {
    return this.players.size;
  }

  state(id: number): PlayerState | undefined {
    return this.players.get(id)?.state;
  }

  /**
   * Queues a client input. Stale or duplicate sequence numbers are ignored.
   * viewTick is the tick the client was showing other players at.
   */
  pushInput(id: number, seq: number, buttons: number, viewTick = this.tick): void {
    const p = this.players.get(id);
    if (!p) return;
    const last = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.ackSeq;
    if (seq <= last) return;
    if (p.queue.length >= MAX_QUEUED_INPUTS) return;
    p.queue.push({ seq, buttons, viewTick });
  }

  /**
   * Runs one server tick. Each input moves its player exactly one step, the
   * same way the client predicted it. A player without input this tick does
   * not move, so a frozen client cannot be pushed around by the server.
   */
  update(): void {
    this.tick++;
    const attacks: { attacker: Player; viewTick: number }[] = [];
    for (const p of this.players.values()) {
      p.budget = Math.min(p.budget + 1, MAX_INPUTS_PER_TICK);
      while (p.budget > 0 && p.queue.length) {
        const input = p.queue.shift()!;
        const next = step(this.map, p.state, input.buttons);
        if (attackStarted(p.state, next)) attacks.push({ attacker: p, viewTick: input.viewTick });
        p.state = next;
        p.ackSeq = input.seq;
        p.budget--;
      }
    }

    this.hits = [];
    for (const { attacker, viewTick } of attacks) this.resolveAttack(attacker, viewTick);

    for (const p of this.players.values()) {
      p.history.push({ tick: this.tick, x: p.state.x, y: p.state.y });
      if (p.history.length > MAX_REWIND_TICKS + 1) p.history.shift();
    }
  }

  /**
   * Lag compensation: the attacker swung at what it saw, which is the other
   * players some ticks ago. Check the swing against where they were then,
   * not where they are now.
   */
  private resolveAttack(attacker: Player, viewTick: number): void {
    const a = attacker.state;
    const rewind = Math.min(Math.max(viewTick, this.tick - MAX_REWIND_TICKS), this.tick - 1);
    const left = a.facing > 0 ? a.x - ATTACK_BOX.back : a.x - ATTACK_BOX.front;
    const right = a.facing > 0 ? a.x + ATTACK_BOX.front : a.x + ATTACK_BOX.back;
    const top = a.y - ATTACK_BOX.up;
    const bottom = a.y + ATTACK_BOX.down;

    for (const target of this.players.values()) {
      if (target === attacker || this.tick < target.hittableAt) continue;
      const pos = positionAt(target, rewind);
      if (
        pos.x + BODY.halfWidth >= left &&
        pos.x - BODY.halfWidth <= right &&
        pos.y >= top &&
        pos.y - BODY.height <= bottom
      ) {
        target.state = applyHit(target.state, a.facing);
        target.hittableAt = this.tick + Physics.hurtTicks;
        this.hits.push({ attacker: attacker.id, target: target.id, tick: rewind });
      }
    }
  }

  ackSeq(id: number): number {
    return this.players.get(id)?.ackSeq ?? 0;
  }

  /** Snapshot for one client: itself plus every player inside its view. */
  snapshotFor(id: number): SnapshotMessage {
    const self = this.players.get(id)?.state;
    const entities = [];
    for (const p of this.players.values()) {
      if (
        self &&
        p.id !== id &&
        (Math.abs(p.state.x - self.x) > this.view.x || Math.abs(p.state.y - self.y) > this.view.y)
      ) {
        continue;
      }
      entities.push({ id: p.id, state: p.state });
    }
    return { op: 3, tick: this.tick, ackSeq: this.ackSeq(id), entities };
  }

  /** True when every snapshot carries every player, so one encoding fits all clients. */
  get seesWholeMap(): boolean {
    return this.view.x === Infinity && this.view.y === Infinity;
  }
}

function positionAt(p: Player, tick: number): { x: number; y: number } {
  for (let i = p.history.length - 1; i >= 0; i--) {
    if (p.history[i]!.tick <= tick) return p.history[i]!;
  }
  return p.history[0] ?? p.state;
}
