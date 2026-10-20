import { loadMap, type GameMap, type MapData } from '../shared/map.js';
import { Button, TICK_RATE, type PlayerState } from '../shared/physics.js';
import { decode, encode, Op, type Message } from '../shared/protocol.js';
import { Interpolator, Predictor } from './netcode.js';
import { connectWebSocket, startLocalServer } from './transport.js';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const ctx = canvas.getContext('2d')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const lagInput = document.querySelector<HTMLInputElement>('#lag')!;
const lagLabel = document.querySelector<HTMLElement>('#lag-value')!;
const predictInput = document.querySelector<HTMLInputElement>('#predict')!;
const interpInput = document.querySelector<HTMLInputElement>('#interp')!;

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function readButtons(): number {
  let b = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) b |= Button.Left;
  if (keys.has('ArrowRight') || keys.has('KeyD')) b |= Button.Right;
  if (keys.has('Space') || keys.has('KeyK') || keys.has('AltLeft')) b |= Button.Jump;
  if (keys.has('ArrowDown') || keys.has('KeyS')) b |= Button.Down;
  return b;
}

/** Simulated one way latency, applied to both directions. */
function lagMs(): number {
  return Number(lagInput.value) / 2;
}

function delayed(fn: () => void): void {
  const ms = lagMs();
  if (ms > 0) setTimeout(fn, ms);
  else fn();
}

const map: GameMap = loadMap((await (await fetch('map.json')).json()) as MapData);
const predictor = new Predictor(map);
const interpolator = new Interpolator(100);
let myId = 0;
let serverSelf: PlayerState | undefined;

// Static hosts have no game server, so run one inside the page instead.
const local =
  new URLSearchParams(location.search).has('local') || location.hostname.endsWith('github.io');
const transport = local
  ? startLocalServer(map, 3)
  : connectWebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
let connected = true;
transport.onMessage = (bytes) => {
  const msg = decode(bytes);
  delayed(() => handle(msg));
};
transport.onClose = () => {
  connected = false;
};

function handle(msg: Message): void {
  if (msg.op === Op.Welcome) {
    myId = msg.playerId;
    return;
  }
  if (msg.op !== Op.Snapshot) return;

  interpolator.push(
    performance.now(),
    msg.entities.filter((e) => e.id !== myId),
  );
  const self = msg.entities.find((e) => e.id === myId);
  if (self) {
    serverSelf = self.state;
    predictor.reconcile(self.state, msg.ackSeq);
  }
}

function sendInput(seq: number, buttons: number): void {
  const bytes = encode({ op: Op.Input, seq, buttons });
  delayed(() => transport.send(bytes));
}

// Client ticks at the same fixed rate as the server.
const tickMs = 1000 / TICK_RATE;
let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += Math.min(now - last, 250);
  last = now;
  while (acc >= tickMs) {
    acc -= tickMs;
    if (myId) {
      const buttons = readButtons();
      sendInput(predictor.apply(buttons), buttons);
    }
  }
  interpolator.delayMs = interpInput.checked ? 100 : 0;
  lagLabel.textContent = `${lagInput.value} ms`;
  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function draw(now: number): void {
  const { width, height } = canvas;
  const self = predictInput.checked ? predictor.state : serverSelf;
  const camX = Math.round((self?.x ?? map.data.spawn.x) - width / 2);
  const camY = Math.round((self?.y ?? map.data.spawn.y) - height * 0.6);

  ctx.fillStyle = '#1b1f2a';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(-camX, -camY);

  ctx.strokeStyle = '#8fb573';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const fh of map.footholds.values()) {
    ctx.moveTo(fh.x1, fh.y1);
    ctx.lineTo(fh.x2, fh.y2);
  }
  ctx.stroke();

  for (const id of interpolator.ids()) {
    const s = interpInput.checked
      ? interpolator.sample(id, now)
      : interpolator.sample(id, Infinity);
    if (s) drawPlayer(s, '#d98b5f', `#${id}`);
  }
  if (serverSelf) drawPlayer(serverSelf, 'rgba(255,255,255,0.25)', '');
  if (self) drawPlayer(self, '#6fa8dc', `#${myId}`);
  ctx.restore();

  if (!connected) {
    hud.textContent = 'disconnected';
    return;
  }
  hud.textContent = [
    local ? 'local server' : 'online',
    `player #${myId || '-'}`,
    `pending inputs ${predictor.pendingCount}`,
    `last correction ${predictor.lastCorrection.toFixed(2)} px`,
  ].join('   ');
}

function drawPlayer(s: PlayerState, color: string, label: string): void {
  const w = 24;
  const h = 40;
  ctx.fillStyle = color;
  ctx.fillRect(s.x - w / 2, s.y - h, w, h);
  ctx.fillRect(s.x + (s.facing > 0 ? w / 2 : -w / 2 - 4), s.y - h + 8, 4, 6);
  if (label) {
    ctx.fillStyle = '#e6e6e6';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, s.x, s.y - h - 6);
  }
}
