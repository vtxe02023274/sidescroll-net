import type { Foothold, MapData, Rope } from '../shared/map.js';

/** The parts of a Tiled JSON map (.tmj) this converter reads. */
interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
}

interface TiledLayer {
  type: string;
  name: string;
  layers?: TiledLayer[];
  objects?: TiledObject[];
  offsetx?: number;
  offsety?: number;
  /** Hidden layers, and everything in a hidden group, are left out. */
  visible?: boolean;
}

interface TiledObject {
  name: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  /** Degrees clockwise around (x, y). */
  rotation?: number;
  point?: boolean;
  polyline?: { x: number; y: number }[];
}

export interface ConvertOptions {
  /** Object layer holding the platform polylines. */
  footholdLayer?: string;
  /** Name or class of the point object used as spawn. */
  spawnName?: string;
  /** Optional object layer whose vertical polylines become ropes. */
  ropeLayer?: string;
}

/**
 * Converts a Tiled JSON map into map data. Every polyline in the foothold
 * layer becomes a chain of linked footholds, one per segment, after applying
 * the object's rotation. Draw them left to right or right to left, either
 * works. Hidden layers are ignored. Vertical segments are skipped
 * since footholds can only be stood on; draw ropes as vertical polylines in
 * a separate `ropes` layer instead.
 */
export function convertTiledMap(
  tiled: TiledMap,
  name: string,
  options: ConvertOptions = {},
): MapData {
  const layerName = options.footholdLayer ?? 'footholds';
  const spawnName = options.spawnName ?? 'spawn';
  const objectLayers = flatten(tiled.layers).filter((l) => l.type === 'objectgroup');

  const layer = objectLayers.find((l) => l.layer.name === layerName);
  if (!layer) throw new Error(`no object layer named '${layerName}'`);

  const footholds: Foothold[] = [];
  let id = 1;
  for (const obj of layer.layer.objects ?? []) {
    const points = polylinePoints(layer, obj);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      let x1 = round(a.x);
      let y1 = round(a.y);
      let x2 = round(b.x);
      let y2 = round(b.y);
      if (x1 === x2) continue;
      if (x1 > x2) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      footholds.push({ id: id++, x1, y1, x2, y2 });
    }
  }
  if (!footholds.length) throw new Error(`layer '${layerName}' has no polylines`);

  const right = tiled.width * tiled.tilewidth;
  const bottom = tiled.height * tiled.tileheight;
  let spawn: { x: number; y: number } | undefined;
  for (const l of objectLayers) {
    const obj = l.layer.objects?.find(
      (o) => o.name === spawnName || o.type === spawnName || o.class === spawnName,
    );
    if (obj) {
      spawn = { x: round(l.offsetX + obj.x), y: round(l.offsetY + obj.y) };
      break;
    }
  }
  if (!spawn) {
    // No spawn point: drop the player above the first foothold.
    const first = footholds[0]!;
    spawn = { x: first.x1, y: Math.max(0, Math.min(first.y1, first.y2) - 1) };
  }

  const ropes: Rope[] = [];
  const ropeLayer = objectLayers.find((l) => l.layer.name === (options.ropeLayer ?? 'ropes'));
  for (const obj of ropeLayer?.layer.objects ?? []) {
    const points = polylinePoints(ropeLayer!, obj);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (Math.abs(a.x - b.x) > 0.5) continue;
      const x = round(a.x);
      const y1 = round(Math.min(a.y, b.y));
      const y2 = round(Math.max(a.y, b.y));
      if (y2 > y1) ropes.push({ id: ropes.length + 1, x, y1, y2 });
    }
  }

  return { name, left: 0, right, bottom, spawn, footholds, ...(ropes.length ? { ropes } : {}) };
}

interface PlacedLayer {
  type: string;
  layer: TiledLayer;
  offsetX: number;
  offsetY: number;
}

/**
 * Map coordinates of the points of a polyline object, rotated by the object's
 * rotation. Tiled rotates clockwise around the object position, and with y
 * pointing down that is the usual rotation formula. Empty for other objects.
 */
function polylinePoints(layer: PlacedLayer, obj: TiledObject): { x: number; y: number }[] {
  const angle = ((obj.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (obj.polyline ?? []).map((p) => ({
    x: layer.offsetX + obj.x + p.x * cos - p.y * sin,
    y: layer.offsetY + obj.y + p.x * sin + p.y * cos,
  }));
}

/** Group layers nest other layers and add their offsets. Hidden layers are skipped. */
function flatten(layers: TiledLayer[], offsetX = 0, offsetY = 0): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  for (const layer of layers) {
    if (layer.visible === false) continue;
    const x = offsetX + (layer.offsetx ?? 0);
    const y = offsetY + (layer.offsety ?? 0);
    if (layer.type === 'group') out.push(...flatten(layer.layers ?? [], x, y));
    else out.push({ type: layer.type, layer, offsetX: x, offsetY: y });
  }
  return out;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
