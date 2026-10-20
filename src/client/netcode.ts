import type { GameMap } from '../shared/map.js';
import { step, type PlayerState } from '../shared/physics.js';
import type { EntitySnapshot } from '../shared/protocol.js';

interface PendingInput {
  seq: number;
  buttons: number;
}

/**
 * Client side prediction for the local player. Inputs are applied right away
 * and kept until the server acknowledges them. When a snapshot arrives the
 * server state is taken as truth and the unacknowledged inputs are replayed
 * on top of it.
 */
export class Predictor {
  state: PlayerState | undefined;
  private pending: PendingInput[] = [];
  private seq = 0;
  /** Distance the last reconciliation moved the player. 0 means the prediction was exact. */
  lastCorrection = 0;

  constructor(private readonly map: GameMap) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Applies one tick of input locally and returns the sequence number to send. */
  apply(buttons: number): number {
    const seq = ++this.seq;
    this.pending.push({ seq, buttons });
    if (this.state) this.state = step(this.map, this.state, buttons);
    return seq;
  }

  reconcile(server: PlayerState, ackSeq: number): void {
    const before = this.state;
    this.pending = this.pending.filter((p) => p.seq > ackSeq);
    let s = server;
    for (const p of this.pending) s = step(this.map, s, p.buttons);
    this.state = s;
    this.lastCorrection = before ? Math.hypot(before.x - s.x, before.y - s.y) : 0;
  }
}

interface Sample {
  time: number;
  state: PlayerState;
}

/**
 * Remote players are drawn slightly in the past, between the two snapshots
 * that surround the render time, so they move smoothly even though updates
 * arrive at a lower rate and with jitter.
 */
export class Interpolator {
  private readonly samples = new Map<number, Sample[]>();
  private readonly ticks: { time: number; tick: number }[] = [];

  constructor(public delayMs: number) {}

  push(time: number, entities: EntitySnapshot[], tick = 0): void {
    this.ticks.push({ time, tick });
    while (this.ticks.length > 2 && this.ticks[0]!.time < time - 1000) this.ticks.shift();

    const seen = new Set<number>();
    for (const { id, state } of entities) {
      seen.add(id);
      let list = this.samples.get(id);
      if (!list) this.samples.set(id, (list = []));
      list.push({ time, state });
      // A second of history is plenty for any sane delay.
      while (list.length > 2 && list[0]!.time < time - 1000) list.shift();
    }
    for (const id of this.samples.keys()) if (!seen.has(id)) this.samples.delete(id);
  }

  /**
   * Server tick that other players are being drawn at. Sent with each input
   * so the server can rewind to what this client saw when checking hits.
   */
  viewTick(now: number): number {
    const t = now - this.delayMs;
    let i = this.ticks.length - 1;
    if (i < 0) return 0;
    while (i > 0 && this.ticks[i - 1]!.time > t) i--;
    const b = this.ticks[i]!;
    const a = this.ticks[i - 1];
    if (!a || t >= b.time) return b.tick;
    if (t <= a.time) return a.tick;
    return Math.floor(a.tick + ((b.tick - a.tick) * (t - a.time)) / (b.time - a.time));
  }

  ids(): number[] {
    return [...this.samples.keys()];
  }

  sample(id: number, now: number): PlayerState | undefined {
    const list = this.samples.get(id);
    if (!list?.length) return undefined;
    const t = now - this.delayMs;

    let i = list.length - 1;
    while (i > 0 && list[i - 1]!.time > t) i--;
    const b = list[i]!;
    const a = list[i - 1];
    if (!a || t >= b.time) return b.state;
    if (t <= a.time) return a.state;

    const k = (t - a.time) / (b.time - a.time);
    return {
      ...b.state,
      x: a.state.x + (b.state.x - a.state.x) * k,
      y: a.state.y + (b.state.y - a.state.y) * k,
    };
  }
}
