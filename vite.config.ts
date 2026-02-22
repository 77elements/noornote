import { defineConfig, type PluginOption } from 'vite';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  // Base URL for assets (absolute for SPA deep-link support)
  base: '/',

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
          // Vendor chunk for external dependencies
          vendor: ['nostr-tools'],
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

  // Expose TAURI_ENV_* variables to frontend (set by `tauri build`)
  envPrefix: ['VITE_', 'TAURI_ENV_'],

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
