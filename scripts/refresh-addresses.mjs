#!/usr/bin/env node
// Explicit network refresh; normal builds use the versioned, compact snapshot.
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const dataset = '3mea-di5p';
const meta = await fetch(`https://data.sf.gov/api/views/${dataset}.json`).then(r => {
  if (!r.ok) throw new Error(`metadata ${r.status}`);
  return r.json();
});
if (meta.licenseId !== 'PDDL') throw new Error('License changed; review before publishing');
const streets = {};
let count = 0;
const seen = new Set();
for (let offset = 0; ; offset += 50000) {
  const url = new URL(`https://data.sf.gov/resource/${dataset}.json`);
  url.search = new URLSearchParams({
    '$select': 'eas_baseid,address_number,address_number_suffix,street_full_street_name,longitude,latitude,cnn',
    '$order': 'eas_baseid', '$limit': '50000', '$offset': String(offset),
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`addresses ${res.status}`);
  const rows = await res.json();
  for (const r of rows) {
    const lng = Number(r.longitude), lat = Number(r.latitude), num = Number(r.address_number);
    if (!Number.isInteger(num) || num <= 0 || !r.street_full_street_name || !(lng > -122.6 && lng < -122.3 && lat > 37.7 && lat < 37.9)) continue;
    const street = r.street_full_street_name;
    const row = [String(num) + (r.address_number_suffix || '').trim(), Math.round((lng + 122) * 1e5), Math.round((lat - 37) * 1e5), Number(r.cnn) || 0];
    const key = street + JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    (streets[street] ??= []).push(row);
    count++;
  }
  console.log(`Read ${offset + rows.length} addresses`);
  if (rows.length < 50000) break;
}
if (count < 200000 || !streets['30TH AVE']?.some(r => r[0] === '534')) throw new Error('Incomplete snapshot; refusing to replace it');
const ordered = Object.fromEntries(Object.keys(streets).sort().map(k => [k, streets[k].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }) || a[3] - b[3])]));
const snapshot = { version: 1, dataset, license: meta.licenseId, sourceUpdated: meta.rowsUpdatedAt, count, streets: ordered };
await mkdir('scripts/data', { recursive: true });
await writeFile('scripts/data/addresses.json.gz', gzipSync(JSON.stringify(snapshot), { level: 9 }));
console.log(`Saved ${count} address points; run pnpm build and commit the snapshot.`);
