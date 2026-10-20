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

export function loadMap(data: MapData): GameMap {
  const footholds = new Map<number, LinkedFoothold>();

  for (const fh of data.footholds) {
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
    if (rope.y2 <= rope.y1) throw new Error(`rope ${rope.id}: y2 must be greater than y1`);
    if (rope.id === 0 || ropes.has(rope.id))
      throw new Error(`rope ${rope.id}: id must be unique and not 0`);
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
