/**
 * Noornote - High-Performance Nostr Web Client
 * Main application entry point
 */

import { App } from './App';
import { AuthService } from './services/AuthService';
import { UserProfileService } from './services/UserProfileService';
import { SystemLogger } from './components/system/SystemLogger';
import { CrashLogger } from './services/CrashLogger';
import './styles/main.scss';
import './services/AuthStateManager'; // Initialize AuthStateManager and window.isLoggedIn()
import './services/MutualChangeService'; // Initialize MutualChangeService (auto-starts on login)

// Track failed image loads (URL → log message for removal)
const failedImageLogs = new Map<string, string>();

// Global error handler for resource loading failures (images, videos, etc.)
// Downgrades console.error to console.warn for non-critical resource failures
window.addEventListener('error', (event) => {
  // Only handle resource loading errors (404, CORS, etc.)
  const target = event.target as HTMLElement;
  if (target instanceof HTMLImageElement || target instanceof HTMLVideoElement) {
    // Prevent default error logging (red in console)
    event.preventDefault();

    const src = target instanceof HTMLImageElement ? target.src : (target as HTMLVideoElement).src;
    const systemLogger = SystemLogger.getInstance();

    // Log to "ImageLoader" category (falls under "Local" in SystemLogger)
    const message = `Failed to load ${target.tagName.toLowerCase()}: ${src} (Resource unavailable)`;
    systemLogger.warn('ImageLoader', message);

    // Track this failure so we can remove it on successful retry
    failedImageLogs.set(src, message);

    // Setup retry listener: if image loads successfully later, remove the error log
    if (target instanceof HTMLImageElement) {
      const onLoad = () => {
        if (failedImageLogs.has(src)) {
          // Remove the error message from System Log (extra points!)
          systemLogger.removeLog('ImageLoader', message);
          failedImageLogs.delete(src);
        }
        target.removeEventListener('load', onLoad);
      };
      target.addEventListener('load', onLoad);
    }
  }
}, true); // Use capture phase to intercept before default handler

// Patch HTMLImageElement.src setter to prevent empty/null/undefined URLs
// This prevents localhost:3000 errors when profile pictures are missing
const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
if (originalSrcDescriptor && originalSrcDescriptor.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    set(value: string) {
      // Only set src if value is truthy and not 'null' string
      if (value && value !== 'null' && value !== 'undefined') {
        originalSrcDescriptor.set!.call(this, value);
      }
      // Silently ignore empty/null/undefined values
    },
    get: originalSrcDescriptor.get,
    configurable: true
  });
}

// Application initialization
async function init(): Promise<void> {
  try {
    // Initialize crash logging FIRST (before anything else can fail)
    await CrashLogger.init();

    // Initialize the main application
    const app = new App();
    await app.initialize();

    // Remove loading screen
    const loadingElement = document.getElementById('loading');
    if (loadingElement) {
      loadingElement.remove();
    }

    // Log ready message with username
    const systemLogger = SystemLogger.getInstance();
    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();

    if (currentUser) {
      const profileService = UserProfileService.getInstance();
      const username = profileService.getUsername(currentUser.pubkey);
      systemLogger.info('Main', `NoorNote ready for user: ${username}`);
    } else {
      systemLogger.info('Main', 'NoorNote ready');
    }
  } catch (error) {
    console.error('Failed to initialize Noornote:', error);

    // Show error message to user
    const appElement = document.getElementById('app');
    if (appElement) {
      appElement.innerHTML = `
        <div class="error-screen">
          <h2>Failed to load Noornote</h2>
          <p>Please refresh the page to try again.</p>
          <button onclick="window.location.reload()">Refresh</button>
        </div>
      `;
    }
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  void init();
}