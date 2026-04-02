import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.noornote.app',
  appName: 'Noornote',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
