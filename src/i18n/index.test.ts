/**
 * Unit tests for the i18n core (gettext-style runtime).
 * Catalogs are injected directly — no storage, no JSON chunks needed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { _, tn, tp, tnp, applyLocaleState, getUiLocale } from './index';
import { setCatalog, clearCatalogs, type Catalog } from './catalog';
import { pluralIndex, normalizeLocale, dirFor } from './plurals';

const DE: Record<string, string | string[]> = {
  Save: 'Speichern',
  'Seen on %s': 'Gesehen auf %s',
  'Backed up %s notes': '%s Notizen gesichert',
  'Delete\x04Delete': 'Löschen',
  'Repost\x04Repost': 'Reposten',
  Repost: 'Repost',
  '%s new note': ['%s neue Notiz', '%s neue Notizen'],
  'Repost\x04%s new repost': ['%s neuer Repost', '%s neue Reposts'],
};

beforeEach(() => {
  clearCatalogs();
  applyLocaleState('en', null);
});

describe('i18n `_` (simple lookup + placeholders)', () => {
  it('returns the msgid when no catalog is active (English fallback)', () => {
    expect(_('Save')).toBe('Save');
  });

  it('returns the translated string for the active catalog', () => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
    expect(_('Save')).toBe('Speichern');
  });

  it('falls back to the msgid when the entry is missing', () => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
    expect(_('Unknown string')).toBe('Unknown string');
  });

  it('replaces sequential %s placeholders', () => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
    expect(_('Seen on %s', 'wss://relay')).toBe('Gesehen auf wss://relay');
  });

  it('supports %N$s explicit positioning', () => {
    const de2: Catalog = { '%1$s of %2$s selected': '%2$s ausgewählt: %1$s' };
    setCatalog('de', de2);
    applyLocaleState('de', de2);
    expect(_('%1$s of %2$s selected', 'A', 'B')).toBe('B ausgewählt: A');
  });

  it('leaves unmatched placeholders untouched', () => {
    expect(_('%s items')).toBe('%s items');
  });

  it('prefers the plain string over a plural-array entry with the same msgid', () => {
    setCatalog('de', { Foo: 'Bar' });
    applyLocaleState('de', { Foo: 'Bar' });
    expect(_('Foo')).toBe('Bar');
  });
});

describe('i18n `tn` (plural forms)', () => {
  beforeEach(() => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
  });

  it('picks form index by the gettext plural formula', () => {
    expect(tn('%s new note', '%s new notes', 1)).toBe('1 neue Notiz');
    expect(tn('%s new note', '%s new notes', 3)).toBe('3 neue Notizen');
  });

  it('auto-inserts n as the first %s argument', () => {
    expect(tn('%s new note', '%s new notes', 5)).toBe('5 neue Notizen');
  });

  it('falls back to the English singular/plural when entry is missing', () => {
    expect(tn('1 apple', '%s apples', 4)).toBe('4 apples');
  });

  it('falls back to the English form when the needed index is absent', () => {
    setCatalog('de', { '1 file': ['eine Datei'] });
    applyLocaleState('de', { '1 file': ['eine Datei'] });
    expect(tn('1 file', '%s files', 5)).toBe('5 files');
  });
});

describe('i18n `tp` (context)', () => {
  beforeEach(() => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
  });

  it('translates a context-qualified entry', () => {
    expect(tp('Delete', 'Delete')).toBe('Löschen');
    expect(tp('Repost', 'Repost')).toBe('Reposten');
  });

  it('falls back to the uncontextualized entry, then the msgid', () => {
    expect(tp('Other', 'Repost')).toBe('Repost');
    expect(tp('Other', 'Unknown')).toBe('Unknown');
  });
});

describe('i18n `tnp` (context + plural)', () => {
  beforeEach(() => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
  });

  it('translates a context-qualified plural entry', () => {
    expect(tnp('Repost', '%s new repost', '%s new reposts', 2)).toBe(
      '2 neue Reposts'
    );
  });

  it('falls back through tn when the contextual entry is missing', () => {
    expect(tnp('Other', '%s new note', '%s new notes', 1)).toBe('1 neue Notiz');
  });
});

describe('i18n locale state', () => {
  it('defaults to en', () => {
    expect(getUiLocale()).toBe('en');
  });

  it('applyLocaleState switches the active locale', () => {
    setCatalog('de', DE);
    applyLocaleState('de', DE);
    expect(getUiLocale()).toBe('de');
    expect(_('Save')).toBe('Speichern');
  });
});

describe('plural formulas', () => {
  it('en/de: two forms, n != 1', () => {
    expect(pluralIndex('en', 1)).toBe(0);
    expect(pluralIndex('en', 2)).toBe(1);
    expect(pluralIndex('de-DE', 0)).toBe(1);
  });

  it('slavic: three forms with the classic russian formula', () => {
    expect(pluralIndex('ru', 1)).toBe(0);
    expect(pluralIndex('ru', 2)).toBe(1);
    expect(pluralIndex('ru', 5)).toBe(2);
    expect(pluralIndex('ru', 21)).toBe(0);
    expect(pluralIndex('ru', 11)).toBe(2);
  });

  it('arabic: six forms', () => {
    expect(pluralIndex('ar', 0)).toBe(0);
    expect(pluralIndex('ar', 1)).toBe(1);
    expect(pluralIndex('ar', 2)).toBe(2);
    expect(pluralIndex('ar', 5)).toBe(3);
    expect(pluralIndex('ar', 11)).toBe(4);
    expect(pluralIndex('ar', 100)).toBe(5);
  });

  it('cjk: single form', () => {
    expect(pluralIndex('ja', 0)).toBe(0);
    expect(pluralIndex('ja', 5)).toBe(0);
  });

  it('normalizes regional locales to their family', () => {
    expect(normalizeLocale('de-DE')).toBe('de');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr-CA')).toBe('en'); // not shipped yet
  });

  it('reports direction per language', () => {
    expect(dirFor('en')).toBe('ltr');
    expect(dirFor('unknown')).toBe('ltr');
  });
});
