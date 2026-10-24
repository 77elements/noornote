/**
 * Plural formulas + language metadata for the i18n core.
 *
 * Formulas follow the GNU gettext plural-expression table, implemented as
 * functions returning the plural-form INDEX (0-based) for a count `n`.
 * Keys are language FAMILIES — a locale like `pt-BR` resolves through
 * `pluralIndex()` to its family entry.
 */

/** Number of plural forms each formula produces (index space size). */
export const PLURAL_FORM_COUNT: Record<string, number> = {
  two: 2,
  french: 2,
  cjk: 1,
  slavic: 3,
  polish: 3,
  czech: 3,
  arabic: 6,
};

type PluralFormula = (n: number) => number;

const FORMULAS: Record<string, PluralFormula> = {
  // en, de, nl, sv, da, nb, fi, it, es, pt, he, tr, … (nplurals=2; n != 1)
  two: n => (n === 1 ? 0 : 1),
  // fr, pt-BR, … (nplurals=2; n > 1)
  french: n => (n > 1 ? 1 : 0),
  // ja, zh, ko, th, id, … (nplurals=1)
  cjk: () => 0,
  // ru, uk, sr, hr, bs, … (nplurals=3; slavic rules)
  slavic: n => {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return 0;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 1;
    return 2;
  },
  // pl (nplurals=3)
  polish: n => {
    if (n === 1) return 0;
    const n10 = n % 10;
    const n100 = n % 100;
    return n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? 1 : 2;
  },
  // cs, sk (nplurals=3)
  czech: n => (n === 1 ? 0 : n >= 2 && n <= 4 ? 1 : 2),
  // ar (nplurals=6)
  arabic: n => {
    if (n === 0) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    const n100 = n % 100;
    if (n100 >= 3 && n100 <= 10) return 3;
    return n100 >= 11 ? 4 : 5;
  },
};

const DEFAULT_FORMULA: PluralFormula = n => (n === 1 ? 0 : 1);

/** Language family → formula key. Unlisted languages fall back to `two`. */
const LANGUAGE_FORMULA: Record<string, string> = {
  en: 'two',
  de: 'two',
  nl: 'two',
  sv: 'two',
  da: 'two',
  nb: 'two',
  nn: 'two',
  fi: 'two',
  it: 'two',
  es: 'two',
  pt: 'two',
  he: 'two',
  sw: 'two',
  fr: 'french',
  tr: 'french',
  ja: 'cjk',
  zh: 'cjk',
  ko: 'cjk',
  th: 'cjk',
  id: 'cjk',
  vi: 'cjk',
  ru: 'slavic',
  uk: 'slavic',
  sr: 'slavic',
  hr: 'slavic',
  bs: 'slavic',
  pl: 'polish',
  cs: 'czech',
  sk: 'czech',
  ar: 'arabic',
};

export interface LanguageMeta {
  /** Language name in its own language — never translated (dropdown label). */
  nativeName: string;
  dir: 'ltr' | 'rtl';
}

/** Available UI languages. A language needs a compiled catalog chunk to work. */
export const LANGUAGES: Record<string, LanguageMeta> = {
  en: { nativeName: 'English', dir: 'ltr' },
  de: { nativeName: 'Deutsch', dir: 'ltr' },
};

/** Primary language subtag: `de-DE` → `de`, `zh_Hans` → `zh`. */
export function primarySubtag(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Locale codes sorted by native name — dropdown-ready. */
export function availableLanguages(): Array<{ code: string } & LanguageMeta> {
  return Object.entries(LANGUAGES)
    .map(([code, meta]) => ({ code, ...meta }))
    .sort((a, b) => a.nativeName.localeCompare(b.nativeName));
}

/**
 * Normalize a locale to an AVAILABLE catalog language (UI selection).
 * Unknown languages fall back to `en` — unlike pluralIndex, this is gated
 * on the languages NoorNote actually ships.
 */
export function normalizeLocale(locale: string): string {
  const lower = locale.toLowerCase();
  if (LANGUAGES[lower]) return lower;
  const primary = primarySubtag(locale);
  if (LANGUAGES[primary]) return primary;
  return 'en';
}

/**
 * Text direction for a locale — resolves like `pluralIndex` by primary
 * subtag so `ar-SA` inherits the `ar` entry's direction once an RTL
 * language is registered in LANGUAGES. Unknown locales are LTR.
 */
export function dirFor(locale: string): 'ltr' | 'rtl' {
  const lower = locale.toLowerCase();
  if (LANGUAGES[lower]) return LANGUAGES[lower].dir;
  const primary = LANGUAGES[primarySubtag(lower)];
  if (primary) return primary.dir;
  return 'ltr';
}

/** Gettext plural-form index for a count in the given locale. */
export function pluralIndex(locale: string, n: number): number {
  // Resolves by language FAMILY (not catalog availability) so formulas
  // already work for languages whose catalogs ship later.
  const family = LANGUAGE_FORMULA[primarySubtag(locale)] ?? 'two';
  const formula = FORMULAS[family] ?? DEFAULT_FORMULA;
  return formula(n);
}
