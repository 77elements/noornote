/**
 * Platform file-IO primitives shared by the diagnostic-log modules.
 *
 * Each helper branches between the Electron main-process IPC bridge
 * (`window.electronAPI`) and the Capacitor Filesystem plugin; on the web
 * build none of them are available and they reject.
 *
 * Canonical home (Redundancy Guard): previously duplicated in
 * DiagnosticLogger.ts and DiagLogExportService.ts.
 */

import { PlatformService } from './PlatformService';

const platform = PlatformService.getInstance();

let _capFsMod: typeof import('@capacitor/filesystem') | null = null;

async function getCapFs() {
  if (!_capFsMod) _capFsMod = await import('@capacitor/filesystem');
  return _capFsMod;
}

async function platformHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('platformHomeDir: not available');
}

async function platformReadDir(
  dirPath: string
): Promise<Array<{ name: string; isFile: boolean }>> {
  if (platform.isElectron) return window.electronAPI!.readDir(dirPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readdir({
      path: dirPath,
      directory: Directory.Data,
    });
    return result.files.map(f => ({ name: f.name, isFile: f.type === 'file' }));
  }
  throw new Error('platformReadDir: not available');
}

async function platformReadTextFile(filePath: string): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.readTextFile(filePath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory, Encoding } = await getCapFs();
    const result = await Filesystem.readFile({
      path: filePath,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return result.data as string;
  }
  throw new Error('platformReadTextFile: not available');
}

async function platformReadFile(filePath: string): Promise<Uint8Array> {
  if (platform.isElectron) {
    const buf = await window.electronAPI!.readFile(filePath);
    return new Uint8Array(buf);
  }
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readFile({
      path: filePath,
      directory: Directory.Data,
    });
    const binary = atob(result.data as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new Error('platformReadFile: not available');
}

async function platformExists(path: string): Promise<boolean> {
  if (platform.isElectron) return window.electronAPI!.fsExists(path);
  if (platform.isCapacitor) {
    try {
      const { Filesystem, Directory } = await getCapFs();
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export {
  getCapFs,
  platformHomeDir,
  platformReadDir,
  platformReadTextFile,
  platformReadFile,
  platformExists,
};
