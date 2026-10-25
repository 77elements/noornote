import { describe, expect, it } from 'vitest';

import { parsePo } from './poParser';

describe('parsePo', () => {
  it('parses a simple header + singular entry', () => {
    const po = [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"Language: fr\\n"',
      '',
      'msgid "Save"',
      'msgstr "Enregistrer"',
      '',
      'msgid "Cancel"',
      'msgstr ""',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.lang).toBe('fr');
    expect(result.catalog).toEqual({ Save: 'Enregistrer' });
    expect(result.stats).toEqual({
      total: 2,
      translated: 1,
      fuzzy: 0,
      untranslated: 1,
    });
  });

  it('distinguishes a multi-line msgid from the header', () => {
    const po = [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"Language: de\\n"',
      '',
      'msgid ""',
      '"This is a long msgid "',
      '"wrapped over lines."',
      'msgstr "Lang."',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.lang).toBe('de');
    expect(result.catalog).toEqual({
      'This is a long msgid wrapped over lines.': 'Lang.',
    });
    expect(result.stats.total).toBe(1);
  });

  it('builds context keys with the EOT separator', () => {
    const po = [
      'msgctxt "Menu"',
      'msgid "Open"',
      'msgstr "Ouvrir"',
      '',
      'msgid "Open"',
      'msgstr "Ouvert"',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.catalog).toEqual({
      'Menu\u0004Open': 'Ouvrir',
      Open: 'Ouvert',
    });
  });

  it('keeps plural gaps and skips all-empty plural entries', () => {
    const po = [
      'msgid "One item"',
      'msgid_plural "%s items"',
      'msgstr[0] "Un objet"',
      'msgstr[1] ""',
      'msgstr[2] "%s objets"',
      '',
      'msgid "One hat"',
      'msgid_plural "%s hats"',
      'msgstr[0] ""',
      'msgstr[1] ""',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.catalog).toEqual({
      'One item': ['Un objet', '', '%s objets'],
    });
    expect(result.stats).toEqual({
      total: 2,
      translated: 1,
      fuzzy: 0,
      untranslated: 1,
    });
  });

  it('counts and includes fuzzy entries', () => {
    const po = [
      '#, fuzzy',
      'msgid "Draft"',
      'msgstr "Entwurf?"',
      '',
      'msgid "Clean"',
      'msgstr "Sauber"',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.catalog).toEqual({ Draft: 'Entwurf?', Clean: 'Sauber' });
    expect(result.stats.fuzzy).toBe(1);
  });

  it('drops obsolete entries', () => {
    const po = [
      '#~ msgid "Old"',
      '#~ msgstr "Alt"',
      '',
      'msgid "New"',
      'msgstr "Neu"',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.catalog).toEqual({ New: 'Neu' });
    expect(result.stats.total).toBe(1);
  });

  it('unescapes po escapes and handles CRLF line endings', () => {
    const po = [
      'msgid "Line one\\nLine \\"two\\" \\\\ end"',
      'msgstr "Zeile \\"eins\\"\\nEnde"',
      '',
    ].join('\r\n');

    const result = parsePo(po);
    expect(result.catalog).toEqual({
      'Line one\nLine "two" \\ end': 'Zeile "eins"\nEnde',
    });
  });

  it('returns null lang when the header has no Language', () => {
    const po = [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '',
      'msgid "Hi"',
      'msgstr "Salut"',
      '',
    ].join('\n');

    const result = parsePo(po);
    expect(result.lang).toBeNull();
    expect(result.catalog).toEqual({ Hi: 'Salut' });
  });
});
