#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync, brotliCompressSync } from 'node:zlib';
const raw = gunzipSync(await readFile('scripts/data/addresses.json.gz'));
const text = raw.toString('utf8');
if (/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F/u.test(text)) throw new Error('Emoji in address index');
const data = JSON.parse(text);
if (data.version !== 1 || data.dataset !== '3mea-di5p' || data.license !== 'PDDL' || data.count < 200000) throw new Error('Invalid address snapshot');
if (raw.length >= 25 * 1024 * 1024) throw new Error('Address index exceeds Pages per-file limit; stop and redesign');
await writeFile('public/addresses.json', raw);
console.log(`Addresses: ${data.count} points; ${raw.length} bytes raw, ${gzipSync(raw, { level: 9 }).length} gzip, ${brotliCompressSync(raw).length} brotli`);
