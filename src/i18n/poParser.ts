/**
 * Minimal .po parser for the session translation preview (WP13 workbench).
 *
 * Accepts the po dialect our own tooling produces (gettext-parser / polib):
 * msgctxt (optional, precedes msgid), msgid, msgid_plural, msgstr[N] blocks,
 * `#,` flag lines, `#|` previous strings and `#~` obsolete entries. Fuzzy
 * entries are kept in the catalog (the preview shows every state a
 * translator produced); obsolete entries are dropped. Output shape matches
 * scripts/i18n-compile.ts so applyLocaleState() can consume it directly:
 *   { msgid | `ctx\u0004msgid`: string | string[] }
 */
import type { Catalog } from './catalog';

export interface PoParseStats {
  /** All entries except the header. */
  total: number;
  /** Entries with at least one non-empty msgstr (present in the catalog). */
  translated: number;
  /** Entries carrying the fuzzy flag (regardless of translation state). */
  fuzzy: number;
  /** total - translated. */
  untranslated: number;
}

export interface PoParseResult {
  /** `Language:` header value, e.g. 'fr' — null when the po has none. */
  lang: string | null;
  catalog: Catalog;
  stats: PoParseStats;
}

/** Resolve po escapes (\n \t \" \\) in one pass. */
function unescapePo(raw: string): string {
  return raw.replace(/\\(.)/g, (match, char: string) => {
    if (char === 'n') return '\n';
    if (char === 't') return '\t';
    if (char === '"') return '"';
    if (char === '\\') return '\\';
    return match;
  });
}

/** Strip the surrounding quotes of a po string literal. */
function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapePo(trimmed.slice(1, -1));
  }
  return '';
}

type AppendField = 'msgid' | 'msgid_plural' | 'msgctxt' | 'msgstr' | null;

interface PendingEntry {
  msgctxt: string;
  msgid: string;
  msgidPlural: string;
  msgstr: string;
  /** Plural form index → text (sparse; gaps preserved compile-style). */
  forms: Map<number, string>;
  fuzzy: boolean;
  /** Field a bare continuation line appends to. */
  appendTo: AppendField;
  appendFormIndex: number;
}

function newPending(): PendingEntry {
  return {
    msgctxt: '',
    msgid: '',
    msgidPlural: '',
    msgstr: '',
    forms: new Map(),
    fuzzy: false,
    appendTo: null,
    appendFormIndex: -1,
  };
}

/** True once the pending entry has collected entry content (not just flags). */
function hasEntryContent(entry: PendingEntry): boolean {
  return (
    entry.msgid !== '' ||
    entry.msgidPlural !== '' ||
    entry.msgstr !== '' ||
    entry.forms.size > 0
  );
}

function contextKey(msgctxt: string, msgid: string): string {
  return msgctxt ? `${msgctxt}\u0004${msgid}` : msgid;
}

export function parsePo(text: string): PoParseResult {
  const lines = text.split(/\r?\n/);
  const catalog: Catalog = {};

  let pending = newPending();
  let lang: string | null = null;
  let total = 0;
  let translated = 0;
  let fuzzyCount = 0;

  const flush = (): void => {
    const entry = pending;
    pending = newPending();

    // Header entry: empty msgid + metadata msgstr (multi-line msgids also
    // start with `msgid ""` but never carry Content-Type).
    if (
      entry.msgid === '' &&
      !entry.msgctxt &&
      entry.msgstr.includes('Content-Type:')
    ) {
      const match = /Language:\s*([^\n;]+)/.exec(entry.msgstr);
      const value = match?.[1];
      if (value !== undefined) lang = value.trim();
      return;
    }
    if (!entry.msgid && !entry.msgctxt) return; // stray keywords, no entry
    total += 1;
    if (entry.fuzzy) fuzzyCount += 1;

    if (entry.msgidPlural) {
      // Keep the full positional array (gaps = ''), compile-style: only
      // entries with at least one non-empty form land in the catalog.
      if ([...entry.forms.values()].some(v => v !== '')) {
        const maxIndex = Math.max(...entry.forms.keys());
        const arr: string[] = [];
        for (let i = 0; i <= maxIndex; i += 1)
          arr[i] = entry.forms.get(i) ?? '';
        catalog[contextKey(entry.msgctxt, entry.msgid)] = arr;
        translated += 1;
      }
      return;
    }
    if (entry.msgstr !== '') {
      catalog[contextKey(entry.msgctxt, entry.msgid)] = entry.msgstr;
      translated += 1;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('#')) {
      if (line.startsWith('#,') && line.includes('fuzzy')) pending.fuzzy = true;
      continue; // comments, references, previous strings, obsolete blocks
    }

    if (line === '') continue;

    if (line.startsWith('msgctxt ')) {
      flush();
      pending.msgctxt = stripQuotes(line.slice('msgctxt'.length));
      pending.appendTo = 'msgctxt';
      continue;
    }

    if (line.startsWith('msgid_plural ')) {
      pending.msgidPlural = stripQuotes(line.slice('msgid_plural'.length));
      pending.appendTo = 'msgid_plural';
      continue;
    }

    if (line.startsWith('msgid ')) {
      // msgctxt precedes msgid within the same entry — only flush when the
      // pending entry already holds content of a previous, complete entry.
      if (hasEntryContent(pending)) {
        flush();
        pending.msgctxt = ''; // fresh entry — a context would have preceded
      }
      pending.msgid = stripQuotes(line.slice('msgid'.length));
      pending.appendTo = 'msgid';
      continue;
    }

    const formMatch = /^msgstr\[(\d+)\]\s*(.*)$/.exec(line);
    if (formMatch) {
      pending.forms.set(Number(formMatch[1]), stripQuotes(formMatch[2] ?? ''));
      pending.appendTo = 'msgstr';
      pending.appendFormIndex = Number(formMatch[1]);
      continue;
    }

    if (line.startsWith('msgstr ')) {
      pending.msgstr = stripQuotes(line.slice('msgstr'.length));
      pending.appendTo = 'msgstr';
      pending.appendFormIndex = -1;
      continue;
    }

    // Bare quoted line = continuation of the previous field.
    if (line.startsWith('"') && pending.appendTo) {
      const value = stripQuotes(line);
      if (pending.appendTo === 'msgid') pending.msgid += value;
      else if (pending.appendTo === 'msgid_plural')
        pending.msgidPlural += value;
      else if (pending.appendTo === 'msgctxt') pending.msgctxt += value;
      else if (pending.appendFormIndex >= 0) {
        const prev = pending.forms.get(pending.appendFormIndex) ?? '';
        pending.forms.set(pending.appendFormIndex, prev + value);
      } else pending.msgstr += value;
      continue;
    }
  }
  flush();

  return {
    lang,
    catalog,
    stats: {
      total,
      translated,
      fuzzy: fuzzyCount,
      untranslated: total - translated,
    },
  };
}
