import { PlatformService } from '../services/PlatformService';
import { ToastService } from '../services/ToastService';

const platform = PlatformService.getInstance();

export async function downloadMedia(url: string, defaultFileName: string): Promise<void> {
  if (platform.isTauri && !platform.isAndroid) {
    // Desktop: save dialog
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
  } else if (platform.isTauri && platform.isAndroid) {
    // Android: save to Downloads folder directly
    const { writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const response = await tauriFetch(url, { method: 'GET' });
    const data = new Uint8Array(await response.arrayBuffer());
    await writeFile(defaultFileName, data, { baseDir: BaseDirectory.Download });
    ToastService.show('Saved to Downloads', 'success');
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
