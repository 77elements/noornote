/**
 * NoorSigner IPC Handlers for Electron
 * NoorSigner IPC Handlers — Unix socket daemon communication.
 *
 * Handles communication with NoorSigner Unix socket daemon,
 * daemon lifecycle, trust sessions, and account management.
 */

import { ipcMain, app } from 'electron';
import { createConnection } from 'node:net';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Path Helpers ──

function getNoornoteBasePath() {
  return path.join(os.homedir(), '.noornote');
}

function getSocketPath() {
  return path.join(os.homedir(), '.noorsigner', 'noorsigner.sock');
}

function getNoorSignerPath() {
  return path.join(getNoornoteBasePath(), 'bin', 'noorsigner');
}

/**
 * Get the sidecar binary path from the app bundle or dev directory.
 * Dev:  <project>/binaries/<platform>-<arch>/noorsigner
 * Prod: <resources>/binaries/noorsigner
 */
function getSidecarSourcePath() {
  if (app.isPackaged) {
    const prodPath = path.join(process.resourcesPath, 'binaries', 'noorsigner');
    if (fs.existsSync(prodPath)) return prodPath;
    throw new Error(`NoorSigner sidecar not found at: ${prodPath}`);
  }

  // Development: binaries/<platform>-<arch>/noorsigner
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const devPath = path.join(app.getAppPath(), 'binaries', `${platform}-${arch}`, 'noorsigner');
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(`NoorSigner sidecar not found at: ${devPath}`);
}

// ── Socket Helpers ──

/**
 * Check if daemon is alive by attempting a socket connection.
 * Cleans up stale socket file on failure.
 */
function isDaemonAlive(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const socket = createConnection(socketPath);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      resolve(false);
    });
    // Short timeout for liveness check
    socket.setTimeout(2000);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for socket file to appear (daemon startup).
 */
async function waitForSocket(socketPath, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(socketPath)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// ── Trust Session Helpers ──

/**
 * Remove expired/broken trust session files so daemon uses password mode.
 */
function cleanupTrustSession() {
  const noorSignerDir = path.join(os.homedir(), '.noorsigner');

  // Old path
  const oldTrust = path.join(noorSignerDir, 'trust_session');
  if (fs.existsSync(oldTrust)) {
    try { fs.unlinkSync(oldTrust); } catch { /* ignore */ }
  }

  // New multi-account path
  const activeFile = path.join(noorSignerDir, 'active_account');
  try {
    const activeNpub = fs.readFileSync(activeFile, 'utf-8').trim();
    if (activeNpub) {
      const trustPath = path.join(noorSignerDir, 'accounts', activeNpub, 'trust_session');
      if (fs.existsSync(trustPath)) {
        fs.unlinkSync(trustPath);
      }
    }
  } catch { /* ignore — file may not exist */ }
}

// ── Two-Step Unlock State ──

/** Holds the daemon child process between prepare and submit steps */
let pendingDaemon = null;

// ── IPC Handler Registration ──

export function registerKeySignerHandlers() {

  // 1. Send JSON-RPC request to NoorSigner daemon via Unix socket
  ipcMain.handle('key-signer:request', async (_event, request) => {
    const socketPath = getSocketPath();

    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = '';

      socket.setTimeout(10000);

      socket.on('connect', () => {
        socket.write(request + '\n');
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
        // Response is newline-terminated
        if (data.includes('\n')) {
          socket.destroy();
          resolve(data.trim());
        }
      });

      socket.on('error', (err) => {
        reject(new Error(`Failed to connect to NoorSigner daemon: ${err.message}. Is the daemon running?`));
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Request timed out - daemon may have crashed or is unresponsive'));
      });
    });
  });

  // 2. Launch NoorSigner in terminal or background
  ipcMain.handle('key-signer:launch', async (_event, mode) => {
    await ensureNoorSignerInstalled();
    const noorSignerPath = getNoorSignerPath();

    if (!fs.existsSync(noorSignerPath)) {
      throw new Error(`NoorSigner binary not found at: ${noorSignerPath}`);
    }

    // Ensure executable
    fs.chmodSync(noorSignerPath, 0o755);

    const validModes = ['init', 'daemon', 'add-account'];
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }

    const hasTrust = await checkTrustSessionInternal();
    const socketPath = getSocketPath();
    const daemonRunning = await isDaemonAlive(socketPath);

    // If trust session valid + daemon not running + daemon mode → try background launch
    if (hasTrust && !daemonRunning && mode === 'daemon') {
      spawn(noorSignerPath, ['daemon'], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      const appeared = await waitForSocket(socketPath, 3000);
      if (appeared) return;

      // Trust session likely invalid — clean up and fall through to terminal
      cleanupTrustSession();
    }

    // Terminal launch for user input
    if (process.platform === 'darwin') {
      const terminalCmd = `${noorSignerPath} ${mode}`;
      const applescript = `tell application "Terminal"\nactivate\ndo script "${terminalCmd}"\nend tell`;
      try {
        execSync(`osascript -e '${applescript.replace(/'/g, "'\"'\"'")}'`);
      } catch (err) {
        throw new Error(`Failed to launch Terminal.app: ${err.message}`);
      }
    } else {
      // Linux: try gnome-terminal, konsole, xterm
      const terminals = [
        { cmd: 'gnome-terminal', args: ['--', noorSignerPath, mode] },
        { cmd: 'konsole', args: ['-e', `${noorSignerPath} ${mode}`] },
        { cmd: 'xterm', args: ['-e', `${noorSignerPath} ${mode}`] },
      ];

      let launched = false;
      for (const { cmd, args } of terminals) {
        try {
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
          launched = true;
          break;
        } catch { /* try next terminal */ }
      }

      if (!launched) {
        throw new Error('No terminal emulator found. Please install gnome-terminal, konsole, or xterm.');
      }
    }
  });

  // 3. Check if trust session is valid
  ipcMain.handle('key-signer:check-trust-session', async () => {
    return checkTrustSessionInternal();
  });

  // 4. Cancel NoorSigner launch (kill daemon process)
  ipcMain.handle('key-signer:cancel-launch', async () => {
    try {
      execSync('pkill -f "noorsigner.*daemon"');
    } catch { /* no process found — that's OK */ }
  });

  // 5. Ensure NoorSigner is installed and up-to-date
  ipcMain.handle('key-signer:ensure-installed', async () => {
    return ensureNoorSignerInstalled();
  });

  // 6. Add account via CLI with stdin
  ipcMain.handle('key-signer:add-account', async (_event, jsonInput) => {
    await ensureNoorSignerInstalled();
    const noorSignerPath = getNoorSignerPath();

    if (!fs.existsSync(noorSignerPath)) {
      throw new Error(`NoorSigner binary not found at: ${noorSignerPath}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(noorSignerPath, ['add-account', '--stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`noorsigner failed: ${stdout.trim()} ${stderr.trim()}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn noorsigner: ${err.message}`));
      });

      child.stdin.write(jsonInput);
      child.stdin.end();
    });
  });

  // 7. Launch daemon silently in background
  ipcMain.handle('key-signer:launch-daemon-silent', async () => {
    await ensureNoorSignerInstalled();
    const noorSignerPath = getNoorSignerPath();

    if (!fs.existsSync(noorSignerPath)) {
      throw new Error(`NoorSigner binary not found at: ${noorSignerPath}`);
    }

    const socketPath = getSocketPath();
    if (await isDaemonAlive(socketPath)) return;

    spawn(noorSignerPath, ['daemon'], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    await waitForSocket(socketPath, 5000);
  });

  // 8. Check if any NoorSigner accounts exist
  ipcMain.handle('key-signer:has-accounts', async () => {
    const accountsDir = path.join(os.homedir(), '.noorsigner', 'accounts');
    if (!fs.existsSync(accountsDir)) return false;

    try {
      const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
      return entries.some(e => e.isDirectory());
    } catch {
      return false;
    }
  });

  // 9. Launch daemon with password piped via stdin
  ipcMain.handle('key-signer:launch-daemon-with-password', async (_event, password) => {
    await ensureNoorSignerInstalled();
    const noorSignerPath = getNoorSignerPath();

    if (!fs.existsSync(noorSignerPath)) {
      throw new Error(`NoorSigner binary not found at: ${noorSignerPath}`);
    }

    const socketPath = getSocketPath();
    if (await isDaemonAlive(socketPath)) return 'already_running';

    return new Promise(async (resolve, reject) => {
      const child = spawn(noorSignerPath, ['daemon', '--password-stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout.on('data', (data) => { stdout += data.toString(); });

      child.stdin.write(password + '\n');
      child.stdin.end();

      const appeared = await waitForSocket(socketPath, 5000);
      if (appeared) {
        resolve('success');
        return;
      }

      // Socket didn't appear — check process
      try {
        const exited = child.exitCode !== null;
        if (exited) {
          if (stdout.includes('Invalid password')) {
            reject(new Error('invalid_password'));
          } else {
            reject(new Error(`Daemon failed to start: ${stdout.trim()}`));
          }
        } else {
          child.kill();
          reject(new Error('Daemon did not start within timeout'));
        }
      } catch (err) {
        reject(new Error(`Daemon launch error: ${err.message}`));
      }
    });
  });

  // 10. Two-step unlock: prepare daemon process
  ipcMain.handle('key-signer:prepare-unlock', async () => {
    await ensureNoorSignerInstalled();
    const noorSignerPath = getNoorSignerPath();

    if (!fs.existsSync(noorSignerPath)) {
      throw new Error(`NoorSigner binary not found at: ${noorSignerPath}`);
    }

    const socketPath = getSocketPath();
    if (await isDaemonAlive(socketPath)) return; // Already running

    // Kill existing pending process
    if (pendingDaemon) {
      try { pendingDaemon.kill(); } catch { /* ignore */ }
      pendingDaemon = null;
    }

    // Remove trust session so daemon uses password
    cleanupTrustSession();

    pendingDaemon = spawn(noorSignerPath, ['daemon', '--password-stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  // 11. Two-step unlock: submit password
  ipcMain.handle('key-signer:submit-password', async (_event, password) => {
    if (!pendingDaemon) {
      throw new Error('No daemon process waiting — call prepare_daemon_for_unlock first');
    }

    const child = pendingDaemon;
    pendingDaemon = null;

    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.stdin.write(password + '\n');
    child.stdin.end();

    const socketPath = getSocketPath();
    const appeared = await waitForSocket(socketPath, 5000);
    if (appeared) return 'success';

    // Socket didn't appear
    const exited = child.exitCode !== null;
    if (exited) {
      if (stdout.includes('Invalid password')) {
        throw new Error('invalid_password');
      }
      throw new Error(`Daemon failed to start: ${stdout.trim()}`);
    }

    child.kill();
    throw new Error('Daemon did not start within timeout');
  });

  // 12. Remove a NoorSigner account
  ipcMain.handle('key-signer:remove-account', async (_event, npub) => {
    if (!npub || !npub.startsWith('npub1')) {
      throw new Error('Invalid npub');
    }

    const noorSignerDir = path.join(os.homedir(), '.noorsigner');
    const accountDir = path.join(noorSignerDir, 'accounts', npub);

    if (fs.existsSync(accountDir)) {
      fs.rmSync(accountDir, { recursive: true });
    }

    // Clear active_account if it points to removed account
    const activeFile = path.join(noorSignerDir, 'active_account');
    try {
      const activeNpub = fs.readFileSync(activeFile, 'utf-8').trim();
      if (activeNpub === npub) {
        fs.unlinkSync(activeFile);
      }
    } catch { /* ignore — file may not exist */ }
  });

  // 13. Check iCloud Keychain (macOS only)
  ipcMain.handle('key-signer:check-icloud-keychain', async () => {
    if (process.platform !== 'darwin') return false;

    try {
      const output = execSync('security list-keychains', { encoding: 'utf-8' });
      return output.includes('iCloud') || output.split('\n').filter(l => l.trim()).length > 2;
    } catch {
      return false;
    }
  });
}

// ── Internal Helpers ──

async function checkTrustSessionInternal() {
  const noorSignerDir = path.join(os.homedir(), '.noorsigner');

  // Try multi-account path first
  let trustSessionPath = path.join(noorSignerDir, 'trust_session'); // fallback

  const activeFile = path.join(noorSignerDir, 'active_account');
  try {
    const activeNpub = fs.readFileSync(activeFile, 'utf-8').trim();
    if (activeNpub) {
      const newPath = path.join(noorSignerDir, 'accounts', activeNpub, 'trust_session');
      if (fs.existsSync(newPath)) {
        trustSessionPath = newPath;
      }
    }
  } catch { /* ignore */ }

  if (!fs.existsSync(trustSessionPath)) return false;

  try {
    const content = fs.readFileSync(trustSessionPath, 'utf-8');
    const parts = content.split(':');
    if (parts.length !== 4) return false;

    const expiresUnix = parseInt(parts[1], 10);
    if (isNaN(expiresUnix)) return false;

    return Math.floor(Date.now() / 1000) < expiresUnix;
  } catch {
    return false;
  }
}

async function ensureNoorSignerInstalled() {
  const targetPath = getNoorSignerPath();
  const targetDir = path.dirname(targetPath);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let needsInstall = true;

  if (fs.existsSync(targetPath)) {
    try {
      const sourcePath = getSidecarSourcePath();
      const sourceSize = fs.statSync(sourcePath).size;
      const targetSize = fs.statSync(targetPath).size;

      if (sourceSize !== targetSize && sourceSize > 0) {
        // Update available
        fs.unlinkSync(targetPath);
      } else {
        needsInstall = false;
      }
    } catch {
      needsInstall = false; // Can't find source — keep existing
    }
  }

  if (!needsInstall) return targetPath;

  const sourcePath = getSidecarSourcePath();
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o755);

  return targetPath;
}
