/**
 * i18n compile — compiles every `src/i18n/po/<lang>.po` (except the en
 * reference catalog) into a runtime JSON chunk at
 * `src/i18n/locales/<lang>.json`, which the i18n core resolves lazily via
 * import.meta.glob.
 *
 * Fuzzy entries (machine-translation drafts, community review pending) are
 * intentionally DROPPED — the runtime falls back to the English msgid until
 * a reviewer un-fuzzies the translation.
 *
 * Run: `bun run i18n:compile` (part of `bun run build`).
 */
import { po } from 'gettext-parser';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PO_DIR = 'src/i18n/po';
const OUT_DIR = 'src/i18n/locales';

const CONTEXT_SEPARATOR = '\u0004';
let compiled = 0;

for (const file of readdirSync(PO_DIR)) {
  if (!file.endsWith('.po') || file === 'en.po') continue;
  const lang = file.replace(/\.po$/, '');

  const parsed = po.parse(readFileSync(join(PO_DIR, file)));
  const catalog: Record<string, string | string[]> = {};
  let fuzzy = 0;
  let translated = 0;

  for (const [ctx, entries] of Object.entries(parsed.translations)) {
    for (const [msgid, msg] of Object.entries(entries)) {
      if (msgid === '') continue;
      if (msg.comments?.flag?.includes('fuzzy')) {
        fuzzy += 1;
        continue;
      }

      const key = ctx ? `${ctx}${CONTEXT_SEPARATOR}${msgid}` : msgid;

      if (msg.msgid_plural) {
        const forms = msg.msgstr.filter(s => s !== '');
        if (forms.length === 0) continue;
        catalog[key] = msg.msgstr; // keep positional gaps for index alignment
        translated += 1;
      } else if (msg.msgstr[0] !== '') {
        catalog[key] = msg.msgstr[0];
        translated += 1;
      }
    }
  }

  writeFileSync(join(OUT_DIR, `${lang}.json`), JSON.stringify(catalog));
  console.log(`${lang}: ${translated} translated, ${fuzzy} fuzzy (dropped)`);
  compiled += 1;
}

console.log(`Compiled ${compiled} catalog(s) → ${OUT_DIR}/`);
