import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { botInput } from '../shared/bot.js';
import { TICK_RATE } from '../shared/physics.js';
import { decode, encode, Op } from '../shared/protocol.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8080' },
    count: { type: 'string', short: 'n', default: '20' },
    seconds: { type: 'string', short: 't', default: '30' },
  },
});

const count = Number(values.count);
const seconds = Number(values.seconds);

let connected = 0;
let snapshots = 0;
let bytesIn = 0;
let failed = 0;

const bots: WebSocket[] = [];
for (let i = 0; i < count; i++) {
  const ws = new WebSocket(values.url);
  let seq = 0;
  let lastTick = 0;
  let timer: NodeJS.Timeout | undefined;
  ws.on('open', () => {
    connected++;
    timer = setInterval(() => {
      seq++;
      ws.send(encode({ op: Op.Input, seq, buttons: botInput(seq, i), viewTick: lastTick }));
    }, 1000 / TICK_RATE);
  });
  ws.on('message', (data: Buffer) => {
    bytesIn += data.byteLength;
    const msg = decode(new Uint8Array(data));
    if (msg.op === Op.Snapshot) {
      snapshots++;
      lastTick = msg.tick;
    }
  });
  ws.on('error', () => failed++);
  ws.on('close', () => clearInterval(timer));
  bots.push(ws);
}

let elapsed = 0;
const report = setInterval(() => {
  elapsed++;
  console.log(
    `${elapsed}s  bots ${connected}/${count}  snapshots/s ${snapshots}  ` +
      `in ${(bytesIn / 1024).toFixed(1)} KiB/s  errors ${failed}`,
  );
  snapshots = 0;
  bytesIn = 0;
  if (elapsed >= seconds) {
    clearInterval(report);
    for (const ws of bots) ws.close();
  }
}, 1000);
