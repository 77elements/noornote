import { PlatformService } from '../services/PlatformService';
import { ToastService } from '../services/ToastService';

const platform = PlatformService.getInstance();

export async function downloadMedia(
  url: string,
  defaultFileName: string
): Promise<void> {
  if (platform.isElectron) {
    // Electron Desktop: save dialog → writeFile
    const filePath = await window.electronAPI!.saveFileDialog({
      defaultPath: defaultFileName,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (filePath) {
      const response = await fetch(url);
      const data = new Uint8Array(await response.arrayBuffer());
      await window.electronAPI!.writeFile(filePath, data);
      ToastService.show('Saved successfully', 'success');
    }
  } else if (platform.isCapacitor) {
    // Capacitor Android: Filesystem plugin
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const response = await fetch(url);
    const blob = await response.blob();
    const reader = new FileReader();
    const base64 = await new Promise<string>(resolve => {
      reader.onload = () =>
        resolve((reader.result as string).split(',')[1] || '');
      reader.readAsDataURL(blob);
    });
    await Filesystem.writeFile({
      path: defaultFileName,
      data: base64,
      directory: Directory.Documents,
    });
    ToastService.show('Saved successfully', 'success');
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
