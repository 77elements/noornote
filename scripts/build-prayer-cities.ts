/**
 * build-prayer-cities.ts — regenerate the bundled GeoNames city dataset for the
 * Nostr-Majlis addon's *calculated* prayer-time sources (adhan needs coords + timezone).
 * The Diyanet (official) source uses its own city list + API and does NOT use this.
 *
 * Source (GeoNames, CC-BY 4.0), download manually into a temp dir first:
 *   curl -O https://download.geonames.org/export/dump/cities15000.zip   (then unzip)
 *   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   curl -O https://download.geonames.org/export/dump/countryInfo.txt
 *
 * Usage:  bun scripts/build-prayer-cities.ts <geonames-dir>
 * Output: src/addons/nostr-majlis/data/prayer-cities.json (lazy-imported by the addon)
 *
 * Output shape (compact):
 *   { v, countries: [[code, name], …], regions: { "<cc>.<a1>": name, … },
 *     cities: [[name, cc, a1, lat, lng, tz], …]  // sorted by population desc }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const srcDir = process.argv[2] || '/tmp/geonames';
const outFile = join(import.meta.dir, '../src/addons/nostr-majlis/data/prayer-cities.json');

const countryNames = new Map<string, string>();
for (const line of readFileSync(join(srcDir, 'countryInfo.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const c = line.split('\t');
  if (c[0] && c[4]) countryNames.set(c[0], c[4]);
}

const regionNames = new Map<string, string>();
for (const line of readFileSync(join(srcDir, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = line.split('\t');
  if (c[0] && c[1]) regionNames.set(c[0], c[1]);
}

interface City { name: string; cc: string; a1: string; lat: number; lng: number; pop: number; tz: string; }
const cities: City[] = [];
for (const line of readFileSync(join(srcDir, 'cities15000.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = line.split('\t');
  const name = c[1], cc = c[8], a1 = c[10] || '', tz = c[17] || '';
  const lat = parseFloat(c[4]), lng = parseFloat(c[5]), pop = parseInt(c[14] || '0', 10);
  if (!name || !cc || !tz || Number.isNaN(lat) || Number.isNaN(lng)) continue;
  cities.push({ name, cc, a1, lat, lng, pop, tz });
}

cities.sort((a, b) => b.pop - a.pop);

const usedCountries = new Set<string>();
const usedRegions = new Set<string>();
for (const city of cities) {
  usedCountries.add(city.cc);
  if (city.a1) usedRegions.add(`${city.cc}.${city.a1}`);
}

const countries = [...usedCountries]
  .map(code => [code, countryNames.get(code) || code] as [string, string])
  .sort((a, b) => a[1].localeCompare(b[1]));

const regions: Record<string, string> = {};
for (const key of usedRegions) regions[key] = regionNames.get(key) || key.split('.')[1];

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const cityRows = cities.map(c => [c.name, c.cc, c.a1, r5(c.lat), r5(c.lng), c.tz]);

const out = { v: 1, countries, regions, cities: cityRows };
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out));

console.log(`Wrote ${outFile}`);
console.log(`  countries: ${countries.length}, regions: ${Object.keys(regions).length}, cities: ${cityRows.length}`);
console.log(`  size: ${(Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(2)} MB`);
