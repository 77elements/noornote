/**
 * AmberSignerService — NIP-55 Android Signer (Amber) Integration
 *
 * Capacitor: nostr-signer-capacitor-plugin (npm)
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
    if (!platform.isCapacitor) return false;
    try {
      const signer = await getSignerPlugin();
      const result = await signer.isExternalSignerInstalled();
      return result.installed;
    } catch {
      return false;
    }
  }

  async login(): Promise<AmberLoginResult> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

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

  async signEvent(
    eventJson: string,
    _pubkey: string
  ): Promise<AmberSignResult> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

    const signer = await getSignerPlugin();
    const id = `sign-${Date.now()}`;
    const result = await signer.signEvent(
      this.packageName,
      eventJson,
      id,
      this.npub
    );
    return { signature: result.signature, event: result.event };
  }

  async nip04Encrypt(
    plaintext: string,
    recipientPubkey: string,
    _currentUser: string
  ): Promise<string> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

    const signer = await getSignerPlugin();
    const result = await signer.nip04Encrypt(
      this.packageName,
      plaintext,
      `enc-${Date.now()}`,
      recipientPubkey,
      this.npub
    );
    return result.result;
  }

  async nip04Decrypt(
    ciphertext: string,
    senderPubkey: string,
    _currentUser: string
  ): Promise<string> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

    const signer = await getSignerPlugin();
    const result = await signer.nip04Decrypt(
      this.packageName,
      ciphertext,
      `dec-${Date.now()}`,
      senderPubkey,
      this.npub
    );
    return result.result;
  }

  async nip44Encrypt(
    plaintext: string,
    recipientPubkey: string,
    _currentUser: string
  ): Promise<string> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

    const signer = await getSignerPlugin();
    const result = await signer.nip44Encrypt(
      this.packageName,
      plaintext,
      `enc-${Date.now()}`,
      recipientPubkey,
      this.npub
    );
    return result.result;
  }

  async nip44Decrypt(
    ciphertext: string,
    senderPubkey: string,
    _currentUser: string
  ): Promise<string> {
    if (!platform.isCapacitor)
      throw new Error('Amber is only available on Capacitor (Android)');

    const signer = await getSignerPlugin();
    const result = await signer.nip44Decrypt(
      this.packageName,
      ciphertext,
      `dec-${Date.now()}`,
      senderPubkey,
      this.npub
    );
    return result.result;
  }

  getPackageName(): string {
    return this.packageName;
  }

  setPackageName(name: string): void {
    this.packageName = name;
  }

  setNpub(npub: string): void {
    this.npub = npub;
  }
}
