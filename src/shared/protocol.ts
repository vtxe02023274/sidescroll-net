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
 */
export const Op = {
  Input: 1,
  Welcome: 2,
  Snapshot: 3,
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
      return {
        op,
        seq: view.getUint32(1, true),
        buttons: view.getUint8(5),
        viewTick: view.getUint32(6, true),
      };
    case Op.Welcome:
      need(4);
      return { op, playerId: view.getUint16(1, true), tickRate: view.getUint8(3) };
    case Op.Snapshot: {
      need(11);
      const count = view.getUint16(9, true);
      need(11 + count * ENTITY_SIZE);
      const entities: EntitySnapshot[] = [];
      let o = 11;
      for (let i = 0; i < count; i++) {
        const flags = view.getUint8(o + 20);
        entities.push({
          id: view.getUint16(o, true),
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
