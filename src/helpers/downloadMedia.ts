import { PlatformService } from '../services/PlatformService';
import { ToastService } from '../services/ToastService';

const platform = PlatformService.getInstance();

export async function downloadMedia(url: string, defaultFileName: string): Promise<void> {
  if (platform.isElectron) {
    // Electron Desktop: save dialog → writeFile
    const filePath = await window.electronAPI!.saveFileDialog({
      defaultPath: defaultFileName,
      filters: [{ name: 'All Files', extensions: ['*'] }]
    });
    if (filePath) {
      const response = await fetch(url);
      const data = new Uint8Array(await response.arrayBuffer());
      await window.electronAPI!.writeFile(filePath, data);
      ToastService.show('Saved successfully', 'success');
    }
  } else if (platform.isTauri && platform.isAndroid) {
    // GrapheneOS: save dialog → content:// URI → Kotlin plugin streams from URL
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const filePath = await save({ defaultPath: defaultFileName });
    if (filePath) {
      await invoke('plugin:media-save|save_media', { uri: filePath, mediaUrl: url });
      ToastService.show('Saved successfully', 'success');
    }
  } else if (platform.isTauri) {
    // Tauri Desktop: save dialog → writeFile
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const response = await tauriFetch(url, { method: 'GET' });
    const data = new Uint8Array(await response.arrayBuffer());
    const filePath = await save({ defaultPath: defaultFileName });
    if (filePath) {
      await writeFile(filePath, data);
      ToastService.show('Saved successfully', 'success');
    }
  } else {
    // Web: blob download
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = defaultFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }
}
