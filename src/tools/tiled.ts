import type { Foothold, MapData } from '../shared/map.js';

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
}

interface TiledObject {
  name: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  point?: boolean;
  polyline?: { x: number; y: number }[];
}

export interface ConvertOptions {
  /** Object layer holding the platform polylines. */
  footholdLayer?: string;
  /** Name or class of the point object used as spawn. */
  spawnName?: string;
}

/**
 * Converts a Tiled JSON map into map data. Every polyline in the foothold
 * layer becomes a chain of linked footholds, one per segment. Draw them left
 * to right or right to left, either works. Vertical segments are skipped
 * since footholds can only be stood on.
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
    if (!obj.polyline) continue;
    for (let i = 0; i + 1 < obj.polyline.length; i++) {
      const a = obj.polyline[i]!;
      const b = obj.polyline[i + 1]!;
      let x1 = round(layer.offsetX + obj.x + a.x);
      let y1 = round(layer.offsetY + obj.y + a.y);
      let x2 = round(layer.offsetX + obj.x + b.x);
      let y2 = round(layer.offsetY + obj.y + b.y);
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

  return { name, left: 0, right, bottom, spawn, footholds };
}

interface PlacedLayer {
  type: string;
  layer: TiledLayer;
  offsetX: number;
  offsetY: number;
}

/** Group layers nest other layers and add their offsets. */
function flatten(layers: TiledLayer[], offsetX = 0, offsetY = 0): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  for (const layer of layers) {
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
