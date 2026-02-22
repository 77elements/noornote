/**
 * AmberSignerService — NIP-55 Android Signer (Amber) Integration
 *
 * Communicates with the Amber Android app via Tauri plugin commands:
 * invoke('plugin:amber|command', args) → Rust → Kotlin → Android Intent/ContentResolver → Amber
 */

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

export class AmberSignerService {
  private static instance: AmberSignerService;
  private packageName: string = '';

  static getInstance(): AmberSignerService {
    if (!AmberSignerService.instance) {
      AmberSignerService.instance = new AmberSignerService();
    }
    return AmberSignerService.instance;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ installed: boolean }>('plugin:amber|is_amber_installed');
      return result.installed;
    } catch {
      return false;
    }
  }

  async login(): Promise<AmberLoginResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberLoginResult>('plugin:amber|login');
    this.packageName = result.packageName;
    return result;
  }

  async signEvent(eventJson: string, pubkey: string): Promise<AmberSignResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AmberSignResult>('plugin:amber|sign_event', {
      eventJson, pubkey, packageName: this.packageName
    });
  }

  async nip04Encrypt(plaintext: string, recipientPubkey: string, currentUser: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip04_encrypt', {
      data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip04Decrypt(ciphertext: string, senderPubkey: string, currentUser: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip04_decrypt', {
      data: ciphertext, pubkey: senderPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip44Encrypt(plaintext: string, recipientPubkey: string, currentUser: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<AmberCryptoResult>('plugin:amber|nip44_encrypt', {
      data: plaintext, pubkey: recipientPubkey, currentUser, packageName: this.packageName
    });
    return result.result;
  }

  async nip44Decrypt(ciphertext: string, senderPubkey: string, currentUser: string): Promise<string> {
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
