/**
 * AmberSignerService — NIP-55 Android Signer (Amber) Integration
 *
 * Capacitor: nostr-signer-capacitor-plugin (npm)
 * Tauri: invoke('plugin:amber|command') (Rust → Kotlin)
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

/** Capacitor NostrSigner plugin singleton */
let _signerPlugin: any = null;
async function getSignerPlugin(): Promise<any> {
  if (!_signerPlugin) {
    const { NostrSignerPlugin } = await import('nostr-signer-capacitor-plugin');
    _signerPlugin = NostrSignerPlugin;
  }
  return _signerPlugin;
}

export class AmberSignerService {
  private static instance: AmberSignerService;
  private packageName: string = '';
  private npub: string = '';

  static getInstance(): AmberSignerService {
    if (!AmberSignerService.instance) {
      AmberSignerService.instance = new AmberSignerService();
    }
    return AmberSignerService.instance;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (platform.isCapacitor) {
        const signer = await getSignerPlugin();
        const result = await signer.isExternalSignerInstalled();
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
      const signer = await getSignerPlugin();
      // Discover Amber's package name first
      const apps = await signer.getInstalledSignerApps();
      if (apps.apps && apps.apps.length > 0) {
        this.packageName = apps.apps[0].packageName;
        await signer.setPackageName(this.packageName);
      }
      const permissions = [
        { type: 'sign_event', kind: 22242 },
        { type: 'nip04_encrypt' },
        { type: 'nip04_decrypt' },
        { type: 'nip44_encrypt' },
        { type: 'nip44_decrypt' },
        { type: 'decrypt_zap_event' },
      ];
      const result = await signer.getPublicKey(this.packageName, permissions);
      this.npub = result.npub || '';
      return { pubkey: result.npub, packageName: this.packageName };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberLoginResult>('plugin:amber|login');
    this.packageName = result.packageName;
    return result;
  }

  async signEvent(eventJson: string, pubkey: string): Promise<AmberSignResult> {
    if (platform.isCapacitor) {
      const signer = await getSignerPlugin();
      const result = await signer.signEvent(this.packageName, eventJson, '', this.npub);
      return { signature: result.signature, event: result.event };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AmberSignResult>('plugin:amber|sign_event', {
      eventJson, pubkey, packageName: this.packageName
    });
  }

  async nip04Encrypt(plaintext: string, recipientPubkey: string, currentUser: string): Promise<string> {
    if (platform.isCapacitor) {
      const signer = await getSignerPlugin();
      const result = await signer.nip04Encrypt(this.packageName, plaintext, '', recipientPubkey, this.npub);
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
      const signer = await getSignerPlugin();
      const result = await signer.nip04Decrypt(this.packageName, ciphertext, '', senderPubkey, this.npub);
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
      const signer = await getSignerPlugin();
      const result = await signer.nip44Encrypt(this.packageName, plaintext, '', recipientPubkey, this.npub);
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
      const signer = await getSignerPlugin();
      const result = await signer.nip44Decrypt(this.packageName, ciphertext, '', senderPubkey, this.npub);
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
