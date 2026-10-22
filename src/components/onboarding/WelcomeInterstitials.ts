/**
 * Welcome Interstitials
 * Marketing banner cards inserted between notes in the Public Timeline
 * Banner 01 (Confrontation), Banner 03 (Bold Minimal),
 * Banner 02 (Get Paid), Banner 05 (Wake Up)
 */

import { _ } from '../../i18n';

/**
 * Create "Them vs Us" confrontation interstitial (Banner 01)
 * Inserted after LoadMore #1
 */
export function createConfrontationInterstitial(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'welcome-interstitial welcome-interstitial--confrontation';
  el.innerHTML = `
    <div class="welcome-interstitial__headline">
      <h2>${_("Social Media that <em>can't</em> betray you.")}</h2>
      <p class="welcome-interstitial__sub">${_('Not "won\'t." Structurally impossible.')}</p>
    </div>
    <div class="welcome-interstitial__comparison">
      <div class="welcome-interstitial__side welcome-interstitial__side--them">
        <div class="welcome-interstitial__label">${_('Every other platform')}</div>
        <ul>
          <li>${_('They can delete your account')}</li>
          <li>${_('They can censor your posts')}</li>
          <li>${_('They own your audience')}</li>
          <li>${_('They sell your data')}</li>
          <li>${_('They can shut down tomorrow')}</li>
        </ul>
      </div>
      <div class="welcome-interstitial__side welcome-interstitial__side--us">
        <div class="welcome-interstitial__label">NoorNote</div>
        <ul>
          <li>${_('Your account is a key you own')}</li>
          <li>${_('Posts live on decentralized relays')}</li>
          <li>${_('Your followers belong to you')}</li>
          <li>${_('Zero tracking, zero data collection')}</li>
          <li>${_('No company, no single point of failure')}</li>
        </ul>
      </div>
    </div>
  `;
  return el;
}

/**
 * Create bold minimal interstitial with explainer (Banner 03)
 * Inserted after LoadMore #3
 */
export function createBoldMinimalInterstitial(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'welcome-interstitial welcome-interstitial--bold';
  el.innerHTML = `
    <h2>${_('They promise freedom.<br>We made it <em>impossible</em><br>to take it away.')}</h2>
    <div class="welcome-interstitial__proofs">
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> ${_('No censorship')}</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> ${_('No account bans')}</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> ${_('No data collection')}</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> ${_('Earn Bitcoin')}</span>
    </div>
    <div class="welcome-interstitial__explainer">
      ${_('<strong>NoorNote</strong> is built on <em>Nostr</em>, an open protocol where your account is a cryptographic key that you own. Your posts are distributed across independent servers worldwide. No company runs it. No one can shut it down.')}
    </div>
  `;
  return el;
}

/**
 * Create "Get Paid" interstitial (Banner 02)
 * Inserted after LoadMore #5
 */
export function createGetPaidInterstitial(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'welcome-interstitial welcome-interstitial--get-paid';
  el.innerHTML = `
    <div class="welcome-interstitial__sats-badge">&#9889;</div>
    <h2>${_('Get paid.<br><em>Not played.</em>')}</h2>
    <p class="welcome-interstitial__sub">${_('Every post can earn you <strong>real money</strong>.<br>No creator fund. No minimum followers. No gatekeepers.')}</p>
  `;
  return el;
}

/**
 * Create "Wake Up" interstitial (Banner 05)
 * Inserted after LoadMore #7
 */
export function createWakeUpInterstitial(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'welcome-interstitial welcome-interstitial--wake-up';
  el.innerHTML = `
    <div class="welcome-interstitial__stat">500M+</div>
    <p class="welcome-interstitial__stat-label">${_('posts deleted by social media platforms last year alone.')}</p>
    <div class="welcome-interstitial__divider"></div>
    <h2>${_('Posts deleted on NoorNote?<br><em>Zero. Ever.</em>')}</h2>
  `;
  return el;
}
