/**
 * SignerTimeoutError
 * Thrown when the active signer (NIP-07 extension, NIP-46 bunker, Amber, …)
 * does not respond within the timeout window. Lets callers distinguish a
 * dead/hung signer from other publish failures and show the right message.
 */
export class SignerTimeoutError extends Error {
  constructor(message: string = 'Signer did not respond in time') {
    super(message);
    this.name = 'SignerTimeoutError';
  }
}
