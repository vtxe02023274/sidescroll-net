import type { PlayerState } from './physics.js';

/**
 * Binary messages, little endian. Every message starts with a one byte opcode.
 *
 * c2s Input     u8 op, u32 seq, u8 buttons, u32 viewTick
 * s2c Welcome   u8 op, u16 playerId, u8 tickRate
 * s2c Snapshot  u8 op, u32 tick, u32 ackSeq, u16 count, count * entity
 *   entity      u16 id, f32 x, f32 y, f32 vx, f32 vy, u16 foothold, u8 flags,
 *               u16 dropFoothold, u8 dropTicks, u8 attackTicks, u8 hurtTicks,
 *               u16 rope, u8 ropeCooldown
 *   flags       bit 0 facing left, bit 1 jump held
 * s2c SnapshotDelta  u8 op, u32 tick, u32 ackSeq, u32 baseTick, u16 count,
 *                    count * (u16 id, u16 mask, changed fields)
 *   Every entity of the snapshot is listed. Bit i of the mask is set when
 *   field i (in the entity order above, after id) differs from the snapshot
 *   at baseTick, and only those fields follow. Entities that were not in the
 *   base have every bit set.
 *
 * Decoders are strict so that an encoder bug or another implementation
 * drifting from this format shows up at once: a message must end exactly
 * where its fields do, an entity id appears at most once per snapshot, and
 * mask bits above the last field are refused.
 */
export const Op = {
  Input: 1,
  Welcome: 2,
  Snapshot: 3,
  SnapshotDelta: 4,
} as const;

export interface InputMessage {
  op: typeof Op.Input;
  seq: number;
  buttons: number;
  /** Server tick the client was showing other players at, used to rewind for hit checks. */
  viewTick: number;
}

export interface WelcomeMessage {
  op: typeof Op.Welcome;
  playerId: number;
  tickRate: number;
}

export interface EntitySnapshot {
  id: number;
  state: PlayerState;
}

export interface SnapshotMessage {
  op: typeof Op.Snapshot;
  tick: number;
  /** Last input sequence the server applied for the receiving client. */
  ackSeq: number;
  entities: EntitySnapshot[];
}

export type Message = InputMessage | WelcomeMessage | SnapshotMessage;

/** The fields of an entity after its id, in wire order. */
const FIELDS: {
  size: 1 | 2 | 4;
  float?: boolean;
  get: (s: PlayerState) => number;
  set: (s: PlayerState, v: number) => void;
}[] = [
  { size: 4, float: true, get: (s) => s.x, set: (s, v) => (s.x = v) },
  { size: 4, float: true, get: (s) => s.y, set: (s, v) => (s.y = v) },
  { size: 4, float: true, get: (s) => s.vx, set: (s, v) => (s.vx = v) },
  { size: 4, float: true, get: (s) => s.vy, set: (s, v) => (s.vy = v) },
  { size: 2, get: (s) => s.foothold, set: (s, v) => (s.foothold = v) },
  {
    size: 1,
    get: (s) => (s.facing < 0 ? 1 : 0) | (s.jumpHeld ? 2 : 0),
    set: (s, v) => {
      s.facing = v & 1 ? -1 : 1;
      s.jumpHeld = (v & 2) !== 0;
    },
  },
  { size: 2, get: (s) => s.dropFoothold, set: (s, v) => (s.dropFoothold = v) },
  { size: 1, get: (s) => s.dropTicks, set: (s, v) => (s.dropTicks = v) },
  { size: 1, get: (s) => s.attackTicks, set: (s, v) => (s.attackTicks = v) },
  { size: 1, get: (s) => s.hurtTicks, set: (s, v) => (s.hurtTicks = v) },
  { size: 2, get: (s) => s.rope, set: (s, v) => (s.rope = v) },
  { size: 1, get: (s) => s.ropeCooldown, set: (s, v) => (s.ropeCooldown = v) },
];
const ALL_FIELDS = (1 << FIELDS.length) - 1;

/**
 * Bits of the fields that differ, in FIELDS order. Written out instead of
 * looping over FIELDS because it runs for every entity of every client.
 * Positions and speeds are already f32 values in the simulation.
 */
function changedFields(a: PlayerState, b: PlayerState): number {
  return (
    (a.x !== b.x ? 1 : 0) |
    (a.y !== b.y ? 2 : 0) |
    (a.vx !== b.vx ? 4 : 0) |
    (a.vy !== b.vy ? 8 : 0) |
    (a.foothold !== b.foothold ? 16 : 0) |
    (a.facing !== b.facing || a.jumpHeld !== b.jumpHeld ? 32 : 0) |
    (a.dropFoothold !== b.dropFoothold ? 64 : 0) |
    (a.dropTicks !== b.dropTicks ? 128 : 0) |
    (a.attackTicks !== b.attackTicks ? 256 : 0) |
    (a.hurtTicks !== b.hurtTicks ? 512 : 0) |
    (a.rope !== b.rope ? 1024 : 0) |
    (a.ropeCooldown !== b.ropeCooldown ? 2048 : 0)
  );
}

/** Largest encoded entity: id, mask and every field. */
const MAX_ENTITY_SIZE = 4 + FIELDS.reduce((n, f) => n + f.size, 0);

/**
 * Encodes a snapshot as the changes from `base`, the last snapshot the
 * receiver got. Over an ordered connection that is simply the previous one
 * sent to it.
 */
export function encodeSnapshotDelta(msg: SnapshotMessage, base: SnapshotMessage): Uint8Array {
  const before = new Map<number, PlayerState>();
  for (const e of base.entities) before.set(e.id, e.state);

  const view = new DataView(new ArrayBuffer(15 + msg.entities.length * MAX_ENTITY_SIZE));
  view.setUint8(0, Op.SnapshotDelta);
  view.setUint32(1, msg.tick, true);
  view.setUint32(5, msg.ackSeq, true);
  view.setUint32(9, base.tick, true);
  view.setUint16(13, msg.entities.length, true);
  let o = 15;
  for (const { id, state } of msg.entities) {
    const old = before.get(id);
    const mask = old ? changedFields(state, old) : ALL_FIELDS;
    view.setUint16(o, id, true);
    view.setUint16(o + 2, mask, true);
    o += 4;
    if (!mask) continue;
    for (let i = 0; i < FIELDS.length; i++) {
      if (!(mask & (1 << i))) continue;
      const f = FIELDS[i]!;
      const v = f.get(state);
      if (f.float) view.setFloat32(o, v, true);
      else if (f.size === 2) view.setUint16(o, v, true);
      else view.setUint8(o, v);
      o += f.size;
    }
  }
  return new Uint8Array(view.buffer, 0, o).slice();
}

/**
 * Decodes messages for one connection, turning snapshot deltas back into
 * full snapshots against the previous snapshot it read.
 */
export class SnapshotReader {
  private last: SnapshotMessage | undefined;

  read(bytes: Uint8Array): Message {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 1 || view.getUint8(0) !== Op.SnapshotDelta) {
      const msg = decode(bytes);
      if (msg.op === Op.Snapshot) this.last = msg;
      return msg;
    }
    const need = (n: number) => {
      if (bytes.byteLength < n)
        throw new DecodeError(`message too short: ${bytes.byteLength} < ${n}`);
    };
    need(15);
    const baseTick = view.getUint32(9, true);
    if (!this.last || this.last.tick !== baseTick) {
      throw new DecodeError(`delta against tick ${baseTick}, last snapshot is ${this.last?.tick}`);
    }
    const before = new Map(this.last.entities.map((e) => [e.id, e.state]));
    const count = view.getUint16(13, true);
    const entities: EntitySnapshot[] = [];
    const seen = new Set<number>();
    let o = 15;
    for (let n = 0; n < count; n++) {
      need(o + 4);
      const id = view.getUint16(o, true);
      const mask = view.getUint16(o + 2, true);
      o += 4;
      if (seen.has(id)) throw new DecodeError(`entity ${id} twice in one snapshot`);
      seen.add(id);
      if (mask & ~ALL_FIELDS) {
        throw new DecodeError(`entity ${id}: unknown mask bits 0x${mask.toString(16)}`);
      }
      const old = before.get(id);
      if (!old && mask !== ALL_FIELDS) throw new DecodeError(`entity ${id} is not in the base`);
      const state = { ...old } as PlayerState;
      FIELDS.forEach((f, i) => {
        if (!(mask & (1 << i))) return;
        need(o + f.size);
        f.set(
          state,
          f.float
            ? view.getFloat32(o, true)
            : f.size === 2
              ? view.getUint16(o, true)
              : view.getUint8(o),
        );
        o += f.size;
      });
      entities.push({ id, state });
    }
    noTrailing(bytes, o);
    const msg: SnapshotMessage = {
      op: Op.Snapshot,
      tick: view.getUint32(1, true),
      ackSeq: view.getUint32(5, true),
      entities,
    };
    this.last = msg;
    return msg;
  }
}

const ENTITY_SIZE = 2 + 4 * 4 + 2 + 1 + 2 + 1 + 1 + 1 + 2 + 1;

export function encode(msg: Message): Uint8Array {
  switch (msg.op) {
    case Op.Input: {
      const view = new DataView(new ArrayBuffer(10));
      view.setUint8(0, msg.op);
      view.setUint32(1, msg.seq, true);
      view.setUint8(5, msg.buttons);
      view.setUint32(6, msg.viewTick, true);
      return new Uint8Array(view.buffer);
    }
    case Op.Welcome: {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint8(0, msg.op);
      view.setUint16(1, msg.playerId, true);
      view.setUint8(3, msg.tickRate);
      return new Uint8Array(view.buffer);
    }
    case Op.Snapshot: {
      const view = new DataView(new ArrayBuffer(11 + msg.entities.length * ENTITY_SIZE));
      view.setUint8(0, msg.op);
      view.setUint32(1, msg.tick, true);
      view.setUint32(5, msg.ackSeq, true);
      view.setUint16(9, msg.entities.length, true);
      let o = 11;
      for (const { id, state: s } of msg.entities) {
        view.setUint16(o, id, true);
        view.setFloat32(o + 2, s.x, true);
        view.setFloat32(o + 6, s.y, true);
        view.setFloat32(o + 10, s.vx, true);
        view.setFloat32(o + 14, s.vy, true);
        view.setUint16(o + 18, s.foothold, true);
        view.setUint8(o + 20, (s.facing < 0 ? 1 : 0) | (s.jumpHeld ? 2 : 0));
        view.setUint16(o + 21, s.dropFoothold, true);
        view.setUint8(o + 23, s.dropTicks);
        view.setUint8(o + 24, s.attackTicks);
        view.setUint8(o + 25, s.hurtTicks);
        view.setUint16(o + 26, s.rope, true);
        view.setUint8(o + 28, s.ropeCooldown);
        o += ENTITY_SIZE;
      }
      return new Uint8Array(view.buffer);
    }
  }
}

/** Rewrites the ack of an encoded snapshot in place. */
export function setSnapshotAck(bytes: Uint8Array, ackSeq: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(5, ackSeq, true);
}

export class DecodeError extends Error {}

function noTrailing(bytes: Uint8Array, end: number): void {
  if (bytes.byteLength > end) {
    throw new DecodeError(`${bytes.byteLength - end} trailing bytes after the message`);
  }
}

export function decode(bytes: Uint8Array): Message {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => {
    if (bytes.byteLength < n)
      throw new DecodeError(`message too short: ${bytes.byteLength} < ${n}`);
  };

  need(1);
  const op = view.getUint8(0);
  switch (op) {
    case Op.Input:
      need(10);
      noTrailing(bytes, 10);
      return {
        op,
        seq: view.getUint32(1, true),
        buttons: view.getUint8(5),
        viewTick: view.getUint32(6, true),
      };
    case Op.Welcome:
      need(4);
      noTrailing(bytes, 4);
      return { op, playerId: view.getUint16(1, true), tickRate: view.getUint8(3) };
    case Op.Snapshot: {
      need(11);
      const count = view.getUint16(9, true);
      need(11 + count * ENTITY_SIZE);
      noTrailing(bytes, 11 + count * ENTITY_SIZE);
      const entities: EntitySnapshot[] = [];
      const seen = new Set<number>();
      let o = 11;
      for (let i = 0; i < count; i++) {
        const id = view.getUint16(o, true);
        if (seen.has(id)) throw new DecodeError(`entity ${id} twice in one snapshot`);
        seen.add(id);
        const flags = view.getUint8(o + 20);
        entities.push({
          id,
          state: {
            x: view.getFloat32(o + 2, true),
            y: view.getFloat32(o + 6, true),
            vx: view.getFloat32(o + 10, true),
            vy: view.getFloat32(o + 14, true),
            foothold: view.getUint16(o + 18, true),
            facing: flags & 1 ? -1 : 1,
            jumpHeld: (flags & 2) !== 0,
            dropFoothold: view.getUint16(o + 21, true),
            dropTicks: view.getUint8(o + 23),
            attackTicks: view.getUint8(o + 24),
            hurtTicks: view.getUint8(o + 25),
            rope: view.getUint16(o + 26, true),
            ropeCooldown: view.getUint8(o + 28),
          },
        });
        o += ENTITY_SIZE;
      }
      return { op, tick: view.getUint32(1, true), ackSeq: view.getUint32(5, true), entities };
    }
    default:
      throw new DecodeError(`unknown opcode ${op}`);
  }
}
