/**
 * Device tier detection for render-cost adaptation.
 *
 * Weak phones (old Android, 2-4 GB RAM, few cores) stall on large
 * synchronous DOM bursts: the timeline paints nothing for hundreds of ms
 * while N note cards are built. High-end devices barely notice. The tier is
 * detected ONCE per session from hardware hints and used to pick render
 * batch sizes — NOT fetch sizes (those are relay-bound, not CPU-bound).
 *
 * Conservative by design: unknown/missing APIs → high tier (no behavior
 * change for devices that don't report anything).
 */

export type DeviceTier = 'high' | 'low';

let cachedTier: DeviceTier | null = null;

/** Reset the memoized tier (test isolation). */
export function resetDeviceTierCache(): void {
  cachedTier = null;
}

export function getDeviceTier(): DeviceTier {
  if (cachedTier) return cachedTier;

  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 0;
  // deviceMemory (Chrome/Android): approximate GB, capped at 8.
  const memoryGb = nav.deviceMemory ?? 0;

  // Only the POSITIVE signals downgrade: if the browser reports neither
  // API, both are 0 and the device stays 'high' (desktop browsers often
  // report hardwareConcurrency but never deviceMemory — that alone must
  // not downgrade a capable desktop).
  cachedTier =
    (memoryGb > 0 && memoryGb <= 4) || (cores > 0 && cores <= 4)
      ? 'low'
      : 'high';
  return cachedTier;
}

/** How many note cards render synchronously before progressive batches start. */
export function getFirstPaintCount(): number {
  return getDeviceTier() === 'low' ? 8 : 12;
}

/** How many note cards each progressive background batch renders. */
export function getRenderBatchSize(): number {
  return getDeviceTier() === 'low' ? 6 : 12;
}
