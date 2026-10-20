import type { GameMap } from '../shared/map.js';
import { spawnPlayer, step, TICK_RATE, type PlayerState } from '../shared/physics.js';
import type { SnapshotMessage } from '../shared/protocol.js';

/** Inputs a client may bank up. Anything beyond this is dropped, which caps speed hacks. */
const MAX_QUEUED_INPUTS = 8;
/** Inputs applied per player per tick when catching up after a lag spike. */
const MAX_INPUTS_PER_TICK = 2;

interface Player {
  id: number;
  state: PlayerState;
  queue: { seq: number; buttons: number }[];
  ackSeq: number;
  /** Inputs the player may still spend; refilled by one each tick. */
  budget: number;
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

  /** Queues a client input. Stale or duplicate sequence numbers are ignored. */
  pushInput(id: number, seq: number, buttons: number): void {
    const p = this.players.get(id);
    if (!p) return;
    const last = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.ackSeq;
    if (seq <= last) return;
    if (p.queue.length >= MAX_QUEUED_INPUTS) return;
    p.queue.push({ seq, buttons });
  }

  /**
   * Runs one server tick. Each input moves its player exactly one step, the
   * same way the client predicted it. A player without input this tick does
   * not move, so a frozen client cannot be pushed around by the server.
   */
  update(): void {
    this.tick++;
    for (const p of this.players.values()) {
      p.budget = Math.min(p.budget + 1, MAX_INPUTS_PER_TICK);
      while (p.budget > 0 && p.queue.length) {
        const input = p.queue.shift()!;
        p.state = step(this.map, p.state, input.buttons);
        p.ackSeq = input.seq;
        p.budget--;
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
