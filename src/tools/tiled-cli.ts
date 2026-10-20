import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMap } from '../shared/map.js';
import { convertTiledMap } from './tiled.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    layer: { type: 'string' },
    spawn: { type: 'string' },
    ropes: { type: 'string' },
  },
});

const input = positionals[0];
if (!input || !values.out) {
  console.error(
    'usage: tiled2map <map.tmj> -o <out.json> [--layer footholds] [--spawn spawn] [--ropes ropes]',
  );
  process.exit(2);
}

try {
  const tiled = JSON.parse(await readFile(input, 'utf8'));
  const name = basename(input, extname(input));
  const map = convertTiledMap(tiled, name, {
    footholdLayer: values.layer,
    spawnName: values.spawn,
    ropeLayer: values.ropes,
  });
  loadMap(map);
  await writeFile(values.out, JSON.stringify(map, null, 2) + '\n');
  console.log(
    `${input}: ${map.footholds.length} footholds, ${map.ropes?.length ?? 0} ropes -> ${values.out}`,
  );
} catch (err) {
  console.error(`${input}: ${(err as Error).message}`);
  process.exit(1);
}
