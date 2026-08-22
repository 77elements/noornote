// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeHtmlAttr, safeHttpUrl, escapeCssUrl } from './escapeHtml';

describe('escapeHtml', () => {
  it('escapes angle brackets so script payloads become inert text', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

describe('escapeHtmlAttr', () => {
  it('escapes all attribute-context metacharacters', () => {
    expect(escapeHtmlAttr('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtmlAttr('normal')).toBe('normal');
  });
});

describe('safeHttpUrl', () => {
  it('allows http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects script-capable schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl('data:text/html,<script>')).toBe('');
    expect(safeHttpUrl('vbscript:msgbox')).toBe('');
  });

  it('rejects garbage and empty input, passes relative URLs through', () => {
    // Note: strings that fail scheme parsing resolve relative to the page
    // origin; the parsed protocol is http(s), so the (harmless, relative)
    // input is returned as-is — no script-capable scheme can survive.
    expect(safeHttpUrl('')).toBe('');
    expect(safeHttpUrl('images/pic.png')).toBe('images/pic.png');
  });
});

describe('escapeCssUrl', () => {
  it('strips quotes and newlines, escapes backslash and single quote', () => {
    // order matters: strip [\r\n"] first, then \\ doubled, then ' escaped
    expect(escapeCssUrl("a'b\nc\"d\\e")).toBe("a\\'bcd\\\\e");
  });
});
