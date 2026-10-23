/**
 * i18n extraction — scans src/ for `_`, `tn`, `tp`, `tnp` calls and writes
 * `src/i18n/po/messages.pot`, then merges the pot into every `<lang>.po`
 * (preserving existing translations) and regenerates `en.po` (msgid = msgstr).
 *
 * Run: `bun run i18n:extract`
 * Guard (WP11): after running, the .po diff must be committed together with
 * the code change that introduced/removed strings.
 *
 * No GNU gettext CLI dependency — merging is done with gettext-parser.
 */
import { GettextExtractor, JsExtractors } from 'gettext-extractor';
import { po } from 'gettext-parser';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PO_DIR = 'src/i18n/po';
const POT_PATH = join(PO_DIR, 'messages.pot');

/** Per-language gettext Plural-Forms headers (extend when adding languages). */
const PLURAL_FORMS: Record<string, string> = {
  en: 'nplurals=2; plural=(n != 1);',
  de: 'nplurals=2; plural=(n != 1);',
};

const NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
};

// ── Extract ──────────────────────────────────────────────────

const extractor = new GettextExtractor();

extractor
  .createJsParser([
    JsExtractors.callExpression('_', { arguments: { text: 0 } }),
    JsExtractors.callExpression('tn', {
      arguments: { text: 0, textPlural: 1 },
    }),
    JsExtractors.callExpression('tp', {
      arguments: { text: 1, context: 0 },
    }),
    JsExtractors.callExpression('tnp', {
      arguments: { text: 1, textPlural: 2, context: 0 },
    }),
  ])
  .parseFilesGlob('src/**/*.ts', {
    ignore: ['src/**/*.test.ts', 'src/i18n/**'],
  });

extractor.savePotFile(POT_PATH);
extractor.printStats();

// ── Merge pot into .po files ─────────────────────────────────

const pot = po.parse(readFileSync(POT_PATH));

/** Flatten gettext-parser's nested translations into `ctx\u0004msgid` keys. */
function flatten(
  translations: po.IPoParse['translations']
): Map<string, po.ITranslationParse> {
  const flat = new Map<string, po.ITranslationParse>();
  for (const [ctx, entries] of Object.entries(translations)) {
    for (const [msgid, msg] of Object.entries(entries)) {
      if (msgid === '') continue; // header
      const key = ctx ? `${ctx}\u0004${msgid}` : msgid;
      flat.set(key, msg);
    }
  }
  return flat;
}

function newPoFile(lang: string): po.IPoParse {
  return {
    charset: 'utf-8',
    headers: {
      'project-id-version': 'NoorNote',
      language: lang,
      'mime-version': '1.0',
      'content-type': 'text/plain; charset=UTF-8',
      'content-transfer-encoding': '8bit',
      'plural-forms': PLURAL_FORMS[lang] ?? 'nplurals=2; plural=(n != 1);',
    },
    translations: { '': {} },
  };
}

function mergeIntoPo(lang: string, path: string, isReference: boolean): void {
  const parsed = existsSync(path)
    ? po.parse(readFileSync(path))
    : newPoFile(lang);

  const potFlat = flatten(pot.translations);
  let added = 0;
  let removed = 0;

  // Add/update entries from the pot.
  for (const [key, potMsg] of potFlat) {
    const eot = key.indexOf('\u0004');
    const ctx = eot === -1 ? '' : key.slice(0, eot);
    const msgid = eot === -1 ? key : key.slice(eot + 1);
    const bucket = parsed.translations[ctx] ?? (parsed.translations[ctx] = {});

    const existing = bucket[msgid];
    if (existing) {
      // Keep the translation, refresh source references + comments.
      existing.comments = {
        ...existing.comments,
        reference: potMsg.comments?.reference ?? '',
        extracted: potMsg.comments?.extracted,
      };
      if (isReference && existing.msgstr[0] === '') {
        existing.msgstr[0] = msgid;
      }
    } else {
      bucket[msgid] = {
        ...(ctx ? { msgctxt: ctx } : {}),
        msgid,
        ...(potMsg.msgid_plural ? { msgid_plural: potMsg.msgid_plural } : {}),
        msgstr: potMsg.msgid_plural ? ['', ''] : isReference ? [msgid] : [''],
        comments: {
          reference: potMsg.comments?.reference ?? '',
          extracted: potMsg.comments?.extracted,
        },
      };
      added += 1;
    }
  }

  // Drop entries that no longer exist in the pot (obsolete strings).
  for (const [ctx, entries] of Object.entries(parsed.translations)) {
    for (const msgid of Object.keys(entries)) {
      if (msgid === '') continue;
      const key = ctx ? `${ctx}\u0004${msgid}` : msgid;
      if (!potFlat.has(key)) {
        delete entries[msgid];
        removed += 1;
      }
    }
  }

  writeFileSync(path, po.compile(parsed));
  console.log(
    `${lang}: ${added} added, ${removed} removed (${existsSync(path) ? 'merged' : 'created'})`
  );
}

// en.po = reference catalog (msgid = msgstr) for translators.
mergeIntoPo('en', join(PO_DIR, 'en.po'), true);

// All target languages: merge against the pot, creating the file if missing.
for (const lang of Object.keys(PLURAL_FORMS)) {
  if (lang === 'en') continue;
  mergeIntoPo(lang, join(PO_DIR, `${lang}.po`), false);
}

console.log('Done.');
