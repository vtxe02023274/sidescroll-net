/**
 * A foothold is a one-way platform segment. Players stand on it from above
 * and can jump through it from below. Footholds whose endpoints touch are
 * linked, so walking off one end continues onto the next.
 */
export interface Foothold {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A rope or ladder: a vertical line players climb with up and down. */
export interface Rope {
  id: number;
  x: number;
  /** Top end. Usually sits on a foothold so climbing up steps onto it. */
  y1: number;
  /** Bottom end. Climbing past it lets go. */
  y2: number;
}

export interface MapData {
  name: string;
  left: number;
  right: number;
  bottom: number;
  spawn: { x: number; y: number };
  footholds: Foothold[];
  ropes?: Rope[];
}

export interface LinkedFoothold extends Foothold {
  prev: number;
  next: number;
}

export interface GameMap {
  data: MapData;
  footholds: Map<number, LinkedFoothold>;
  ropes: Map<number, Rope>;
}

const LINK_EPSILON = 0.5;

/** Ids are u16 on the wire and 0 means none, so they run from 1 to 65535. */
const MAX_ID = 65535;

function checkNumbers(what: string, obj: object, keys: string[]): void {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${what}: ${k} must be a finite number, got ${JSON.stringify(v)}`);
    }
  }
}

function checkId(what: string, id: unknown): void {
  if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > MAX_ID) {
    throw new Error(`${what}: id must be an integer from 1 to ${MAX_ID}`);
  }
}

/**
 * Checks map data and links its footholds. Map files are hand written or
 * converted, so anything the simulation or the wire format cannot represent
 * is refused here instead of breaking players later.
 */
export function loadMap(data: MapData): GameMap {
  checkNumbers('map', data, ['left', 'right', 'bottom']);
  if (data.left >= data.right) throw new Error('map: left must be less than right');
  checkNumbers('spawn', data.spawn ?? {}, ['x', 'y']);
  const { spawn } = data;
  if (spawn.x < data.left || spawn.x > data.right || spawn.y > data.bottom) {
    throw new Error(`spawn (${spawn.x}, ${spawn.y}) must be inside the map bounds`);
  }

  const footholds = new Map<number, LinkedFoothold>();

  for (const fh of data.footholds) {
    checkId(`foothold ${fh.id}`, fh.id);
    checkNumbers(`foothold ${fh.id}`, fh, ['x1', 'y1', 'x2', 'y2']);
    if (fh.x2 <= fh.x1) {
      throw new Error(`foothold ${fh.id}: x2 must be greater than x1`);
    }
    if (footholds.has(fh.id)) {
      throw new Error(`foothold ${fh.id}: duplicate id`);
    }
    footholds.set(fh.id, { ...fh, prev: 0, next: 0 });
  }

  for (const a of footholds.values()) {
    for (const b of footholds.values()) {
      if (a === b) continue;
      if (Math.abs(a.x2 - b.x1) < LINK_EPSILON && Math.abs(a.y2 - b.y1) < LINK_EPSILON) {
        a.next = b.id;
        b.prev = a.id;
      }
    }
  }

  const ropes = new Map<number, Rope>();
  for (const rope of data.ropes ?? []) {
    checkId(`rope ${rope.id}`, rope.id);
    checkNumbers(`rope ${rope.id}`, rope, ['x', 'y1', 'y2']);
    if (rope.y2 <= rope.y1) throw new Error(`rope ${rope.id}: y2 must be greater than y1`);
    if (ropes.has(rope.id)) throw new Error(`rope ${rope.id}: duplicate id`);
    ropes.set(rope.id, rope);
  }

  return { data, footholds, ropes };
}

/** Height of the foothold at x. Callers make sure x is within the segment. */
export function footholdY(fh: Foothold, x: number): number {
  const t = (x - fh.x1) / (fh.x2 - fh.x1);
  return fh.y1 + (fh.y2 - fh.y1) * t;
}

export function footholdContains(fh: Foothold, x: number): boolean {
  return x >= fh.x1 && x <= fh.x2;
}
