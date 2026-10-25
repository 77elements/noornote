/**
 * CSS production-pipeline guard — regression test for the 1.9.2 incident.
 *
 * What broke: Vite 8 silently switched the default CSS minifier from esbuild to
 * lightningcss. lightningcss treats -webkit-backdrop-filter as an alias of the
 * standard backdrop-filter property and keeps only the LAST declaration — which
 * in our sources is the -webkit- one. The standard property was stripped from
 * every marble-glass rule (dropdowns, menus, toasts). Chromium and Firefox do
 * NOT support the -webkit- alias (only Safari does), so all glass surfaces
 * rendered without backdrop blur in production builds — while the dev server
 * (unminified) looked fine, which is why localhost never showed the bug.
 *
 * Two layers of defense here:
 * 1. The real vite.config must pin build.cssMinify to 'esbuild'.
 * 2. A real Vite CLI build of a tiny fixture (inheriting the real config's
 *    minify/cssMinify/target settings) must emit BOTH the standard and
 *    -webkit- property, with a correctly space-separated filter list. This
 *    catches any future pipeline change that strips or mangles the
 *    declaration, regardless of which minifier is responsible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import realConfig from '../../vite.config';

const run = promisify(execFile);

const FIXTURE_SCSS = `
.glass {
  background: color-mix(in srgb, var(--color-2) 40%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
}
`;

let fixtureRoot = '';

beforeAll(() => {
  // Keep the fixture inside the project's node_modules (gitignored, no /tmp
  // per repo rules). __dirname is src/styles/ → two levels up is the root.
  fixtureRoot = mkdtempSync(
    resolve(__dirname, '../../node_modules/.vite-css-guard-')
  );
  writeFileSync(
    join(fixtureRoot, 'index.html'),
    '<!doctype html><html><body><script type="module" src="./entry.ts"></script></body></html>'
  );
  writeFileSync(join(fixtureRoot, 'entry.ts'), "import './glass.scss';");
  writeFileSync(join(fixtureRoot, 'glass.scss'), FIXTURE_SCSS);

  // Generated config: embeds the REAL vite.config's minification settings as
  // literals so this test tracks the real config automatically instead of
  // maintaining a drifting mirror. We do not import the real config into the
  // fixture build — that would pull its plugins (build-id writer, visualizer)
  // in.
  const realBuild = realConfig.build ?? {};
  const realCss = realConfig.css ?? {};
  const inherited = JSON.stringify({
    minify: realBuild.minify,
    cssMinify: realBuild.cssMinify,
    target: realBuild.target,
    cssTransformer: realCss.transformer,
    lightningcss: realCss.lightningcss,
  });
  writeFileSync(
    join(fixtureRoot, 'vite.guard.config.ts'),
    [
      "import { defineConfig } from 'vite';",
      `const inherited = ${inherited};`,
      'export default defineConfig({',
      '  root: import.meta.dirname,',
      '  build: {',
      '    minify: inherited.minify,',
      '    cssMinify: inherited.cssMinify,',
      '    target: inherited.target,',
      `    outDir: ${JSON.stringify(join(fixtureRoot, 'dist'))},`,
      '    emptyOutDir: true,',
      '  },',
      '  css: {',
      '    transformer: inherited.cssTransformer,',
      '    lightningcss: inherited.lightningcss,',
      '  },',
      '});',
      '',
    ].join('\n')
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('production CSS pipeline (backdrop-filter guard)', () => {
  it('pins cssMinify to esbuild (lightningcss strips backdrop-filter)', () => {
    expect(
      realConfig.build?.cssMinify,
      'build.cssMinify in vite.config.ts'
    ).toBe('esbuild');
  });

  it('emits both standard and -webkit-backdrop-filter with valid spacing', async () => {
    const viteBin = resolve(__dirname, '../../node_modules/.bin/vite');
    await run(
      viteBin,
      ['build', '--config', join(fixtureRoot, 'vite.guard.config.ts')],
      {
        cwd: resolve(__dirname, '../..'),
      }
    );

    const distDir = join(fixtureRoot, 'dist', 'assets');
    const cssFile = readdirSync(distDir).find(f => f.endsWith('.css'));
    expect(cssFile, 'build emitted no CSS asset').toBeTruthy();
    const css = readFileSync(join(distDir, cssFile as string), 'utf8');

    // Standard property must survive minification with a space-separated
    // filter list (Chromium/Firefox production rendering depends on it).
    expect(css).toMatch(
      /[^-]backdrop-filter:\s*blur\(10px\)\s+saturate\(1\.2\)/
    );
    // The alias must survive too (Safari).
    expect(css).toMatch(
      /-webkit-backdrop-filter:\s*blur\(10px\)\s+saturate\(1\.2\)/
    );
    // Guard against whitespace-stripped filter lists (unparseable in some engines).
    expect(css).not.toMatch(/blur\(10px\)saturate/);
  });
});
