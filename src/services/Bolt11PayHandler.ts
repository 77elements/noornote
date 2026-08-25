/**
 * Bolt11 Pay Handler
 *
 * Event delegation on document — one listener catches all clicks on
 * `.bolt11-invoice__pay` buttons rendered by renderBolt11.ts.
 *
 * Prefers WebLN (browser extension), falls back to NWC.
 */

import { NWCService } from './NWCService';
import { ToastService } from './ToastService';
import { ErrorService } from './ErrorService';

let initialized = false;

export function initBolt11PayHandler(): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener('click', async event => {
    const target = event.target as HTMLElement;
    const btn = target.closest(
      '.bolt11-invoice__pay'
    ) as HTMLButtonElement | null;
    if (!btn) return;

    const card = btn.closest('.bolt11-invoice') as HTMLElement | null;
    const invoice = card?.dataset.invoice;
    if (!invoice) return;

    if (btn.disabled) return;

    event.preventDefault();
    event.stopPropagation();

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Paying…';
    btn.classList.add('loading');

    try {
      await payInvoice(invoice);
      btn.textContent = 'Paid ✓';
      btn.classList.remove('loading');
      btn.classList.add('bolt11-invoice__pay--paid');
      ToastService.show('Payment sent', 'success');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove('loading');
      ErrorService.handle(err, 'Failed to pay invoice');
    }
  });
}

async function payInvoice(invoice: string): Promise<void> {
  // Prefer WebLN if available (browser extension like Alby)
  const webln = window.webln;
  if (webln && typeof webln.sendPayment === 'function') {
    try {
      if (typeof webln.enable === 'function') {
        await webln.enable();
      }
      await webln.sendPayment(invoice);
      return;
    } catch (err) {
      // Fall through to NWC
      console.warn('[Bolt11PayHandler] WebLN failed, trying NWC:', err);
    }
  }

  // NWC fallback
  const nwc = NWCService.getInstance();
  if (!nwc.isConnected()) {
    throw new Error(
      'No Lightning wallet connected. Configure NWC in Settings → Zaps.'
    );
  }
  await nwc.payInvoice(invoice);
}
