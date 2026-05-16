import { defineConfig, type PluginOption } from 'vite';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  // Base URL: './' for Electron (file:// protocol), '/' for Web (SPA deep links)
  base: process.env.ELECTRON_BUILD ? './' : '/',

  // Development server configuration
  server: {
    port: 3000,
    host: '127.0.0.1', // Explicit IPv4 localhost instead of 'true'
    open: false, // Don't auto-open browser (Tauri app will open instead)
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 3000,
      clientPort: 3000,
    },
    // Prevent browser caching of assets in dev mode
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
    // Proxy for media uploads to bypass CORS in development
    proxy: {
      '/proxy/blossom.nostr.build': {
        target: 'https://blossom.nostr.build',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/blossom\.nostr\.build/, ''),
      },
      '/proxy/nostr.build': {
        target: 'https://nostr.build',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/nostr\.build/, ''),
      },
      '/proxy/blossom.band': {
        target: 'https://blossom.band',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/blossom\.band/, ''),
      },
      '/proxy/blossom.primal.net': {
        target: 'https://blossom.primal.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/blossom\.primal\.net/, ''),
      },
      // In dev mode, the NosPress font endpoints must hit the live PHP
      // (Vite serves .php as static text). Path lives under
      // `_nospress-user/fonts/` to stay clear of the app's static `/fonts/`.
      '/_nospress-user/fonts/upload.php': {
        target: 'https://noornote.app',
        changeOrigin: true,
      },
      '/_nospress-user/fonts/delete.php': {
        target: 'https://noornote.app',
        changeOrigin: true,
      },
    },
  },

  // Build configuration
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,

    // Bundle size optimization
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        manualChunks: {
          // Nostr protocol
          'nostr-tools': ['nostr-tools'],
          // NDK core
          ndk: ['@nostr-dev-kit/ndk'],
          // IndexedDB (Dexie)
          dexie: ['dexie'],
          // Crypto primitives (@noble, @scure) used by nostr-tools + NDK
          crypto: ['@noble/hashes', '@noble/curves', '@noble/ciphers', '@scure/base', '@scure/bip32', '@scure/bip39'],
          // Calendar / date (dayjs + Hijri)
          calendar: ['dayjs', '@calidy/dayjs-calendarsystems', '@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem'],
        },
        // Asset naming for caching
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
      // Suppress warnings for intentional mixed dynamic/static imports
      // These are used for code-splitting, lazy loading, and circular dependency avoidance
      onwarn(warning, warn) {
        // Suppress "is dynamically imported by ... but also statically imported" warnings
        if (warning.code === 'PLUGIN_WARNING' &&
            warning.message?.includes('dynamically imported') &&
            warning.message?.includes('statically imported')) {
          return;
        }
        // Suppress eval warnings from external packages (tseep)
        if (warning.code === 'EVAL' && warning.id?.includes('node_modules')) {
          return;
        }
        warn(warning);
      },
    },

    // Performance budgets (500KB gzipped target)
    chunkSizeWarningLimit: 600, // KB uncompressed

    // Minification
    minify: 'esbuild',
    cssMinify: true,
  },

  // CSS configuration
  css: {
    devSourcemap: true,
  },

  // TypeScript path resolution
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@components': resolve(__dirname, 'src/components'),
      '@services': resolve(__dirname, 'src/services'),
      '@helpers': resolve(__dirname, 'src/helpers'),
      '@state': resolve(__dirname, 'src/state'),
      '@types': resolve(__dirname, 'src/types'),
    },
  },

  // Plugin configuration
  plugins: [
    // Bundle analyzer for development
    ...(process.env.ANALYZE ? [visualizer({
      filename: 'dist/bundle-analysis.html',
      open: true,
      gzipSize: true,
      brotliSize: true,
    }) as PluginOption] : []),
  ],

  envPrefix: ['VITE_'],

  // Environment variables
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },

  // Preview server (for production builds)
  preview: {
    port: 4173,
    host: true,
  },
});
