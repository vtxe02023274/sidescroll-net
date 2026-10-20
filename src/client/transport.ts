import { Game } from '../server/game.js';
import { botInput } from '../shared/bot.js';
import type { GameMap } from '../shared/map.js';
import { TICK_RATE } from '../shared/physics.js';
import {
  decode,
  encode,
  encodeSnapshotDelta,
  Op,
  type SnapshotMessage,
} from '../shared/protocol.js';

export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage: (bytes: Uint8Array) => void;
  onClose: () => void;
}

export function connectWebSocket(url: string): Transport {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const t: Transport = {
    send(bytes) {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    },
    onMessage: () => {},
    onClose: () => {},
  };
  ws.onmessage = (e) => t.onMessage(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => t.onClose();
  return t;
}

/**
 * Runs the authoritative server inside the page, with a few bots, so the
 * demo works on a static host. Bytes still go through encode and decode, so
 * the client code path is the same as with a real server.
 */
export function startLocalServer(map: GameMap, bots: number): Transport {
  const game = new Game(map);
  const me = game.addPlayer();
  const botIds = Array.from({ length: bots }, () => game.addPlayer());
  let botSeq = 0;
  let last: SnapshotMessage | undefined;

  const t: Transport = {
    send(bytes) {
      const msg = decode(bytes);
      if (msg.op === Op.Input) game.pushInput(me, msg.seq, msg.buttons, msg.viewTick);
    },
    onMessage: () => {},
    onClose: () => {},
  };

  queueMicrotask(() => t.onMessage(encode({ op: Op.Welcome, playerId: me, tickRate: TICK_RATE })));
  setInterval(() => {
    botSeq++;
    botIds.forEach((id, i) => game.pushInput(id, botSeq, botInput(botSeq, i * 40 + 5)));
    game.update();
    if (game.tick % 2 === 0) {
      const snapshot = game.snapshotFor(me);
      t.onMessage(last ? encodeSnapshotDelta(snapshot, last) : encode(snapshot));
      last = snapshot;
    }
  }, 1000 / TICK_RATE);

  return t;
}
