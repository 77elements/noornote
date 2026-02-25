/**
 * Welcome Interstitials
 * Marketing banner cards inserted between notes in the Public Timeline
 * Banner 01 (Confrontation), Banner 03 (Bold Minimal),
 * Banner 02 (Get Paid), Banner 05 (Wake Up)
 */

/**
 * Create "Them vs Us" confrontation interstitial (Banner 01)
 * Inserted after LoadMore #1
 */
export function createConfrontationInterstitial(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'welcome-interstitial welcome-interstitial--confrontation';
  el.innerHTML = `
    <div class="welcome-interstitial__headline">
      <h2>Social Media that <em>can't</em> betray you.</h2>
      <p class="welcome-interstitial__sub">Not "won't." Structurally impossible.</p>
    </div>
    <div class="welcome-interstitial__comparison">
      <div class="welcome-interstitial__side welcome-interstitial__side--them">
        <div class="welcome-interstitial__label">Every other platform</div>
        <ul>
          <li>They can delete your account</li>
          <li>They can censor your posts</li>
          <li>They own your audience</li>
          <li>They sell your data</li>
          <li>They can shut down tomorrow</li>
        </ul>
      </div>
      <div class="welcome-interstitial__side welcome-interstitial__side--us">
        <div class="welcome-interstitial__label">NoorNote</div>
        <ul>
          <li>Your account is a key you own</li>
          <li>Posts live on decentralized relays</li>
          <li>Your followers belong to you</li>
          <li>Zero tracking, zero data collection</li>
          <li>No company, no single point of failure</li>
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
    <h2>They promise freedom.<br>We made it <em>impossible</em><br>to take it away.</h2>
    <div class="welcome-interstitial__proofs">
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> No censorship</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> No account bans</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> No data collection</span>
      <span class="welcome-interstitial__proof"><span class="welcome-interstitial__dot"></span> Earn Bitcoin</span>
    </div>
    <div class="welcome-interstitial__explainer">
      <strong>NoorNote</strong> is built on <em>Nostr</em>, an open protocol where
      your account is a cryptographic key that you own. Your posts are distributed
      across independent servers worldwide. No company runs it. No one can shut it down.
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
    <h2>Get paid.<br><em>Not played.</em></h2>
    <p class="welcome-interstitial__sub">Every post can earn you <strong>real money</strong>.<br>No creator fund. No minimum followers. No gatekeepers.</p>
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
    <p class="welcome-interstitial__stat-label">posts deleted by social media platforms last year alone.</p>
    <div class="welcome-interstitial__divider"></div>
    <h2>Posts deleted on NoorNote?<br><em>Zero. Ever.</em></h2>
  `;
  return el;
}
