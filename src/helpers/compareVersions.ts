/**
 * Compare two semantic version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const aParts = parse(a);
  const bParts = parse(b);

  for (let i = 0; i < 3; i++) {
    const av = aParts[i] || 0;
    const bv = bParts[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  return 0;
}
