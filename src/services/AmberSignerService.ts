/**
 * AmberSignerService — NIP-55 Android Signer (Amber) Integration
 *
 * Supports both Capacitor and Tauri backends:
 * - Capacitor: Capacitor.Plugins.Amber (local Kotlin plugin)
 * - Tauri: invoke('plugin:amber|command') (Rust → Kotlin)
 */

import { PlatformService } from './PlatformService';

interface AmberLoginResult {
  pubkey: string;
  packageName: string;
}

interface AmberSignResult {
  signature: string;
  event: string;
}

interface AmberCryptoResult {
  result: string;
}

const platform = PlatformService.getInstance();

/** Get the Capacitor Amber plugin (lazy) */
async function getAmberPlugin(): Promise<any> {
  const { registerPlugin } = await import('@capacitor/core');
  return registerPlugin('Amber');
}

export class AmberSignerService {
  private static instance: AmberSignerService;
  private packageName: string = '';
  private capacitorPlugin: any = null;

  static getInstance(): AmberSignerService {
    if (!AmberSignerService.instance) {
      AmberSignerService.instance = new AmberSignerService();
    }
    return AmberSignerService.instance;
  }

  private async getPlugin(): Promise<any> {
    if (platform.isCapacitor) {
      if (!this.capacitorPlugin) {
        this.capacitorPlugin = await getAmberPlugin();
      }
      return this.capacitorPlugin;
    }
    return null; // Tauri path uses invoke() directly
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (platform.isCapacitor) {
        const plugin = await this.getPlugin();
        const result = await plugin.isAmberInstalled();
        return result.installed;
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ installed: boolean }>('plugin:amber|is_amber_installed');
      return result.installed;
    } catch {
      return false;
    }
  }

  async login(): Promise<AmberLoginResult> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      const result = await plugin.login();
      this.packageName = result.packageName;
      return result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberLoginResult>('plugin:amber|login');
    this.packageName = result.packageName;
    return result;
  }

  async signEvent(eventJson: string, pubkey: string): Promise<AmberSignResult> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      return plugin.signEvent({ eventJson, pubkey, packageName: this.packageName });
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AmberSignResult>('plugin:amber|sign_event', {
      eventJson, pubkey, packageName: this.packageName
    });
  }

  async nip04Encrypt(plaintext: string, recipientPubkey: string, currentUser: string): Promise<string> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      const result = await plugin.nip04Encrypt({ data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName });
      return result.result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip04_encrypt', {
      data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip04Decrypt(ciphertext: string, senderPubkey: string, currentUser: string): Promise<string> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      const result = await plugin.nip04Decrypt({ data: ciphertext, pubkey: senderPubkey, currentUser, packageName: this.packageName });
      return result.result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip04_decrypt', {
      data: ciphertext, pubkey: senderPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string, currentUser: string): Promise<string> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      const result = await plugin.nip44Encrypt({ data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName });
      return result.result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip44_encrypt', {
      data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string, currentUser: string): Promise<string> {
    if (platform.isCapacitor) {
      const plugin = await this.getPlugin();
      const result = await plugin.nip44Decrypt({ data: ciphertext, pubkey: senderPubkey, currentUser, packageName: this.packageName });
      return result.result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip44_decrypt', {
      data: ciphertext, pubkey: senderPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  getPackageName(): string {
    return this.packageName;
  }

  setPackageName(name: string): void {
    this.packageName = name;
  }
}
