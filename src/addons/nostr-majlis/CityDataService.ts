/**
 * CityDataService - lazy access to the bundled GeoNames city dataset (calculation sources).
 *
 * Used only by the *calculated* prayer-time sources (adhan needs coords + timezone). The
 * dataset (data/prayer-cities.json, ~2 MB) is loaded via dynamic import so rollup emits it
 * as a separate chunk fetched only when a calculation source's picker is shown. Regenerate
 * with scripts/build-prayer-cities.ts. Fully on-device. See docs/todos/muslims-addon.md.
 */

import type { DropdownOption } from '../../components/ui/CustomDropdown';
import type { CalcCity } from './index';
import { diagLog } from '../../services/DiagnosticLogger';

export interface CityData {
  v: number;
  /** [code, name] sorted by country name. */
  countries: [string, string][];
  /** "<cc>.<a1>" -> region name. */
  regions: Record<string, string>;
  /** [name, cc, a1, lat, lng, tz], sorted by population desc. */
  cities: [string, string, string, number, number, string][];
}

let cache: CityData | null = null;

export async function loadCityData(): Promise<CityData> {
  if (cache) return cache;
  const mod = (await import('./data/prayer-cities.json')) as unknown as {
    default: CityData;
  };
  cache = mod.default;
  diagLog('addons', 'nostr-majlis: city dataset loaded', {
    cities: cache.cities.length,
  });
  return cache;
}

export function countryOptions(data: CityData): DropdownOption[] {
  return data.countries.map(([value, label]) => ({ value, label }));
}

export function regionOptions(data: CityData, cc: string): DropdownOption[] {
  const seen = new Map<string, string>();
  for (const [, ccc, a1] of data.cities) {
    if (ccc !== cc) continue;
    const key = a1 || '';
    if (!seen.has(key))
      seen.set(key, key ? data.regions[`${cc}.${key}`] || key : '(Other)');
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function cityOptions(
  data: CityData,
  cc: string,
  a1: string
): DropdownOption[] {
  const out: DropdownOption[] = [];
  data.cities.forEach((c, i) => {
    if (c[1] === cc && (c[2] || '') === a1)
      out.push({ value: String(i), label: c[0] });
  });
  return out;
}

export function resolveCity(data: CityData, index: number): CalcCity | null {
  const c = data.cities[index];
  if (!c) return null;
  const [name, cc, a1, lat, lng, tz] = c;
  const country = data.countries.find(x => x[0] === cc)?.[1] || cc;
  const region = a1 ? data.regions[`${cc}.${a1}`] || '' : '';
  const label = [name, region, country].filter(Boolean).join(', ');
  return { name, cc, a1, lat, lng, tz, label };
}
