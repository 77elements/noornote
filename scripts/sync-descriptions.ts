#!/usr/bin/env bun
// Sync NoorNote app description from app-description.yaml into all target files.
// Usage: bun scripts/sync-descriptions.ts [--check]
//   --check  exit 1 if any target file would change (CI / build-validate mode)

import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');
const SOURCE_FILE = 'app-description.yaml';
const CHECK_MODE = process.argv.includes('--check');

type Source = Record<string, string>;

// Minimal YAML parser for app-description.yaml.
// Only supports top-level keys with `>` (folded) or `|` (literal) block scalars,
// 2-space indentation, `#` comments, and blank lines. Not a general parser.
function parseYaml(content: string): Source {
  const result: Source = {};
  const lines = content.split('\n');
  let key: string | null = null;
  let style: '>' | '|' | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!key || !style) return;
    if (style === '|') {
      while (buffer.length && buffer[0] === '') buffer.shift();
      while (buffer.length && buffer[buffer.length - 1] === '') buffer.pop();
      result[key] = buffer.join('\n');
    } else {
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const line of buffer) {
        if (line === '') {
          if (current.length) paragraphs.push(current.join(' '));
          current = [];
        } else {
          current.push(line);
        }
      }
      if (current.length) paragraphs.push(current.join(' '));
      result[key] = paragraphs.join('\n\n');
    }
    key = null;
    style = null;
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().startsWith('#')) continue;

    const keyMatch = line.match(/^([a-z_][a-z0-9_]*):\s*([|>])\s*$/);
    if (keyMatch) {
      flush();
      key = keyMatch[1];
      style = keyMatch[2] as '>' | '|';
      continue;
    }

    if (key) {
      if (line.trim() === '') {
        buffer.push('');
      } else if (line.startsWith('  ')) {
        buffer.push(line.slice(2));
      }
    }
  }
  flush();

  return result;
}

function loadSource(): Source {
  const content = readFileSync(join(ROOT, SOURCE_FILE), 'utf-8');
  const src = parseYaml(content);
  const required = [
    'short',
    'meta_main',
    'meta_download',
    'og_download',
    'zapstore_summary',
    'paragraph_1',
    'paragraph_2',
    'urls_block',
    'platform_matrix_md',
  ];
  const missing = required.filter(k => !src[k]);
  if (missing.length) {
    throw new Error(`${SOURCE_FILE}: missing keys: ${missing.join(', ')}`);
  }
  return src;
}

// Patch a top-level JSON key. Preserves 2-space indent and trailing newline.
function patchJsonKey(content: string, key: string, value: string): string {
  const obj = JSON.parse(content);
  if (obj[key] === value) return content;
  obj[key] = value;
  return JSON.stringify(obj, null, 2) + '\n';
}

// Replace content inside <!-- desc-sync:NAME --> ... <!-- /desc-sync:NAME --> markers.
// Preserves indentation of the opening marker line.
function patchMarker(content: string, name: string, newInner: string): string {
  const re = new RegExp(
    `([ \\t]*)<!-- desc-sync:${name} -->\\n[\\s\\S]*?\\n[ \\t]*<!-- /desc-sync:${name} -->`,
    'm',
  );
  if (!re.test(content)) {
    throw new Error(`Marker <!-- desc-sync:${name} --> not found`);
  }
  return content.replace(re, (_match, indent: string) => {
    const indented = newInner
      .split('\n')
      .map(line => (line === '' ? '' : indent + line))
      .join('\n');
    return `${indent}<!-- desc-sync:${name} -->\n${indented}\n${indent}<!-- /desc-sync:${name} -->`;
  });
}

// Patch zapstore.yaml `summary` (single line) and `description` (|-block scalar).
function patchZapstoreYaml(content: string, summary: string, descriptionBlock: string): string {
  let updated = content.replace(/^summary: .*$/m, `summary: ${summary}`);

  const indented = descriptionBlock
    .split('\n')
    .map(line => (line === '' ? '' : '  ' + line))
    .join('\n');

  updated = updated.replace(
    /^(description: \|\n)((?:  [^\n]*\n|\n)*)/m,
    (_match, header: string) => `${header}${indented}\n\n`,
  );
  return updated;
}

type Change = { file: string; before: string; after: string };

function computeChanges(src: Source): Change[] {
  const changes: Change[] = [];
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
  const record = (rel: string, updated: string, original: string) => {
    if (updated !== original) changes.push({ file: rel, before: original, after: updated });
  };

  // package.json
  {
    const rel = 'package.json';
    const content = read(rel);
    record(rel, patchJsonKey(content, 'description', src.short), content);
  }

  // public/manifest.json (append period)
  {
    const rel = 'public/manifest.json';
    const content = read(rel);
    record(rel, patchJsonKey(content, 'description', src.short + '.'), content);
  }

  // index.html
  {
    const rel = 'index.html';
    const content = read(rel);
    const updated = patchMarker(
      content,
      'meta-main',
      `<meta name="description" content="${src.meta_main}" />`,
    );
    record(rel, updated, content);
  }

  // public/download/index.html — meta, og, hero
  {
    const rel = 'public/download/index.html';
    const content = read(rel);
    let updated = patchMarker(
      content,
      'meta-download',
      `<meta name="description" content="${src.meta_download}">`,
    );
    updated = patchMarker(
      updated,
      'og-download',
      `<meta property="og:description" content="${src.og_download}">`,
    );
    const hero =
      `<p class="hero-desc">\n  ${src.paragraph_1}\n</p>\n` +
      `<p class="hero-desc">\n  ${src.paragraph_2}\n</p>`;
    updated = patchMarker(updated, 'hero', hero);
    record(rel, updated, content);
  }

  // README.md
  {
    const rel = 'README.md';
    const content = read(rel);
    const intro = `${src.paragraph_1}\n\n${src.paragraph_2}\n\n${src.platform_matrix_md}`;
    record(rel, patchMarker(content, 'intro', intro), content);
  }

  // zapstore.yaml
  {
    const rel = 'zapstore.yaml';
    const content = read(rel);
    const full = `${src.paragraph_1}\n\n${src.paragraph_2}\n\n${src.urls_block}`;
    record(rel, patchZapstoreYaml(content, src.zapstore_summary, full), content);
  }

  return changes;
}

function main() {
  const src = loadSource();
  const changes = computeChanges(src);

  if (changes.length === 0) {
    console.log(`✓ All description targets in sync with ${SOURCE_FILE}`);
    return;
  }

  if (CHECK_MODE) {
    console.error(`✗ Description drift detected — these files do not match ${SOURCE_FILE}:`);
    for (const c of changes) console.error(`  - ${c.file}`);
    console.error('');
    console.error(`The app description source is ${SOURCE_FILE}.`);
    console.error('Never edit description text directly in target files.');
    console.error('Run: bun run desc:sync');
    process.exit(1);
  }

  for (const c of changes) {
    writeFileSync(join(ROOT, c.file), c.after);
    console.log(`  updated ${c.file}`);
  }
  console.log(`✓ Synced ${changes.length} file${changes.length === 1 ? '' : 's'}`);
}

main();
