import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadMap, type MapData } from '../shared/map.js';
import { decode, encode, Op, DecodeError, setSnapshotAck } from '../shared/protocol.js';
import { Game } from './game.js';

const PORT = Number(process.env.PORT ?? 8080);
/** Snapshots go out every other tick; clients interpolate the gaps. */
const SNAPSHOT_EVERY = 2;

const root = fileURLToPath(new URL('../..', import.meta.url));
const publicDir = join(root, 'public');
const mapFile = process.env.MAP ?? join(root, 'maps', 'field.json');
const mapData = JSON.parse(await readFile(mapFile, 'utf8')) as MapData;
const view = process.env.VIEW ? process.env.VIEW.split('x').map(Number) : undefined;
const game = new Game(loadMap(mapData), view ? { view: { x: view[0]!, y: view[1]! } } : {});

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(publicDir, path));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = path === '/map.json' ? JSON.stringify(mapData) : await readFile(file);
    res.writeHead(200, {
      'content-type': contentTypes[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

const sockets = new Map<number, WebSocket>();
const wss = new WebSocketServer({ server: http, maxPayload: 64 });

wss.on('connection', (ws) => {
  const id = game.addPlayer();
  sockets.set(id, ws);
  ws.send(encode({ op: Op.Welcome, playerId: id, tickRate: game.tickRate }));

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    try {
      const msg = decode(new Uint8Array(data as Buffer));
      if (msg.op === Op.Input) game.pushInput(id, msg.seq, msg.buttons, msg.viewTick);
    } catch (err) {
      if (!(err instanceof DecodeError)) throw err;
      ws.close(1003, 'bad message');
    }
  });

  ws.on('close', () => {
    game.removePlayer(id);
    sockets.delete(id);
  });
});

// Fixed timestep driven by wall clock, so a slow tick is made up for instead of drifting.
const tickMs = 1000 / game.tickRate;
let next = performance.now();
const stats = { ticks: 0, busyMs: 0, worstMs: 0, bytesOut: 0 };

function broadcast() {
  // Without a view limit everyone gets the same entity list and only the ack
  // differs, so encode once and patch the ack per client.
  const shared = game.seesWholeMap ? encode(game.snapshotFor(0)) : undefined;
  for (const [id, ws] of sockets) {
    let bytes: Uint8Array;
    if (shared) {
      bytes = shared.slice();
      setSnapshotAck(bytes, game.ackSeq(id));
    } else {
      bytes = encode(game.snapshotFor(id));
    }
    ws.send(bytes);
    stats.bytesOut += bytes.byteLength;
  }
}

function loop() {
  const now = performance.now();
  while (now >= next) {
    const start = performance.now();
    game.update();
    if (game.tick % SNAPSHOT_EVERY === 0) broadcast();
    const took = performance.now() - start;
    stats.ticks++;
    stats.busyMs += took;
    stats.worstMs = Math.max(stats.worstMs, took);
    next += tickMs;
  }
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

setInterval(() => {
  if (!stats.ticks) return;
  console.log(
    `players ${game.playerCount}  tick avg ${(stats.busyMs / stats.ticks).toFixed(2)} ms ` +
      `max ${stats.worstMs.toFixed(2)} ms  out ${(stats.bytesOut / 10 / 1024).toFixed(1)} KiB/s`,
  );
  Object.assign(stats, { ticks: 0, busyMs: 0, worstMs: 0, bytesOut: 0 });
}, 10_000).unref();

http.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
