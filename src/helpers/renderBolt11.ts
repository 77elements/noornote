/**
 * Replace __BOLT11_N__ placeholders in processed HTML with invoice card markup.
 *
 * Amethyst-parity layout: Lightning icon + "Lightning Invoice" label + amount + Pay button.
 * Nothing more.
 */

import { escapeHtmlAttr } from './escapeHtml';
import type { Bolt11Match } from './extractBolt11';

export function replaceBolt11Placeholders(
  html: string,
  invoices: Bolt11Match[]
): string {
  if (invoices.length === 0) return html;

  return html.replace(
    /__BOLT11_(\d+)__/g,
    (_m: string, idx: string): string => {
      const match = invoices[parseInt(idx, 10)];
      if (!match) return '';
      return renderBolt11Card(match);
    }
  );
}

function renderBolt11Card(match: Bolt11Match): string {
  const invoiceAttr = escapeHtmlAttr(match.invoice);
  const amountStr = formatSats(match.amount);
  return `<div class="bolt11-invoice" data-invoice="${invoiceAttr}">
    <div class="bolt11-invoice__header">
      <svg class="bolt11-invoice__icon" width="20" height="20"><use href="#icon-zap"/></svg>
      <span class="bolt11-invoice__label">Lightning Invoice</span>
    </div>
    <div class="bolt11-invoice__amount">${amountStr} sats</div>
    <button class="btn bolt11-invoice__pay" type="button">Pay</button>
  </div>`;
}

function formatSats(sats: number): string {
  return sats.toLocaleString('en-US');
}
