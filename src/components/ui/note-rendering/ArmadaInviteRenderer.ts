/**
 * ArmadaInviteRenderer - Awareness card for Concord encrypted-community
 * invite links (kind 33301, CORD-05).
 *
 * The invite bundle's content is NIP-44 encrypted under a symmetric key
 * derived from the URL's `#fragment` (an unlock token). NoorNote can't
 * join an encrypted community, but with the fragment it can decrypt the
 * bundle's public preview (community name, icon, channel count) to render
 * a real invitation — the same preview Armada shows before you accept.
 * The primary action opens the invite in Armada (or copies the link).
 *
 * Integration pattern mirrors DittoFeatureRenderer / SatelliteSiteRenderer:
 *  - QuotedNoteRenderer.renderAddressableReference routes kind 33301 here
 *    when it sees the naddr, with the fragment carried through from the
 *    URL via extractQuotedReferences' `fragment` field.
 *  - UnsupportedKindRenderer also routes 33301 here as a safety net for
 *    the bare-event path (rare — the addressable-quote path is the norm).
 *  - RepostRenderer.dispatchInnerEvent routes inner-33301 events here.
 *
 * Documented architecture exception: this renderer calls NostrTransport
 * (fetchDirect) directly. Armada/CORD is an isolated protocol family with its
 * own transport access (see ArmadaRelayClient's raw-WebSocket exception in
 * /build-validate Step 26); routing this single fetch through a module would
 * invent structure without decoupling anything. Do NOT add further direct
 * transport calls here.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { decodeInviteFragment } from '../../../helpers/armada/decodeInviteFragment';
import { decodeInviteBundle } from '../../../helpers/armada/decodeInviteBundle';
import { decryptArmadaImage } from '../../../helpers/armada/decryptArmadaImage';
import { parseArmadaInvite } from '../../../helpers/armada/parseArmadaInvite';
import {
  INVITE_BUNDLE_KIND,
  type ArmadaInvitePreview,
} from '../../../helpers/armada/types';
import { diagLog } from '../../../services/DiagnosticLogger';
import { NostrTransport } from '../../../services/transport/NostrTransport';

/** Render states (used as CSS modifier on the root). */
type ArmadaCardState =
  | 'missing-secret' // URL has no fragment → can't decrypt
  | 'loading' // fragment decoded, fetching bundle
  | 'ready' // bundle decrypted, preview shown
  | 'expired' // bundle decrypted but past expires_at
  | 'fetch-failed' // bundle fetch or decrypt failed
  | 'incomplete'; // bare naddr quote, no fragment (Path B)

const ARMADA_FETCH_TIMEOUT_MS = 15000;
const COPY_FEEDBACK_MS = 2000;

export class ArmadaInviteRenderer {
  /**
   * Render the invite card from a bare naddr coordinate, optionally with
   * the `#fragment` secret preserved through extractQuotedReferences.
   *
   * This is the entry point used by QuotedNoteRenderer.renderAddressableReference
   * and UnsupportedKindRenderer.renderFromCoordinate.
   */
  static renderFromCoordinate(
    naddr: string,
    fragment: string | undefined
  ): HTMLElement {
    const parsed = parseArmadaInvite(fragment ? `${naddr}#${fragment}` : naddr);
    if (!parsed) {
      // Not an invite-bundle naddr (shouldn't happen — caller checks kind 33301).
      // Fall through to a minimal static card with the open-in-armada link only.
      return ArmadaInviteRenderer.renderStatic(naddr);
    }
    return ArmadaInviteRenderer.renderCard(parsed);
  }

  /**
   * Render the invite card straight from a fetched kind 33301 event.
   * Used by RepostRenderer.dispatchInnerEvent when a repost wraps a 33301.
   * Without the URL fragment there is no decrypt path → static card.
   */
  static renderFromEvent(event: NostrEvent): HTMLElement {
    const element = ArmadaInviteRenderer.renderStatic(
      // Build the naddr from the event coordinate (d="" for invite bundles).
      // No fragment → static "Encrypted" card; the open-in-armada link uses
      // the bare naddr (Armada itself will prompt for the fragment).
      '',
      event
    );
    return element;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // internals

  private static renderStatic(naddr: string, _event?: NostrEvent): HTMLElement {
    const root = document.createElement('div');
    root.className = 'armada-invite armada-invite--incomplete';
    const openUrl = naddr ? `https://armada.buzz/invite/${naddr}` : '';
    root.innerHTML = ArmadaInviteRenderer.cardHtml({
      state: 'incomplete',
      name: 'Encrypted community',
      openUrl,
    });
    return root;
  }

  private static renderCard(
    invite: NonNullable<ReturnType<typeof parseArmadaInvite>>
  ): HTMLElement {
    const root = document.createElement('div');
    root.className = 'armada-invite';

    // Missing secret → static "Encrypted" card (the open link still works
    // armada-side; Armada will prompt for the fragment if it was stripped).
    if (invite.missingSecret) {
      root.classList.add('armada-invite--missing-secret');
      root.innerHTML = ArmadaInviteRenderer.cardHtml({
        state: 'missing-secret',
        name: 'Encrypted community',
        openUrl: invite.openUrl,
      });
      ArmadaInviteRenderer.wireActions(root, invite.openUrl);
      return root;
    }

    // Decode the fragment synchronously. If it fails (wrong version,
    // truncated, future format), fall back to the static card.
    const decoded = decodeInviteFragment(invite.fragment);
    if (!decoded) {
      root.classList.add('armada-invite--fetch-failed');
      root.innerHTML = ArmadaInviteRenderer.cardHtml({
        state: 'fetch-failed',
        name: 'Encrypted community',
        openUrl: invite.openUrl,
      });
      ArmadaInviteRenderer.wireActions(root, invite.openUrl);
      diagLog('system', 'Armada invite: fragment decode failed', {
        linkSigner: invite.linkSigner.slice(0, 8),
      });
      return root;
    }

    // Loading skeleton, then async decrypt.
    root.classList.add('armada-invite--loading');
    root.innerHTML = ArmadaInviteRenderer.cardHtml({
      state: 'loading',
      name: '',
      openUrl: invite.openUrl,
    });
    ArmadaInviteRenderer.wireActions(root, invite.openUrl);

    void ArmadaInviteRenderer.loadPreview(
      root,
      invite,
      decoded.token,
      decoded.relays
    ).catch(() => {
      /* loadPreview already downgrades to fetch-failed */
    });

    return root;
  }

  /**
   * Fetch the bundle from the fragment's bootstrap relays (which always host
   * it per CORD-05 §3) + our app pool as fallback. Take the newest event at
   * the coordinate. Decrypt the preview and update the DOM. On any failure
   * downgrade to the static card.
   */
  private static async loadPreview(
    root: HTMLElement,
    invite: NonNullable<ReturnType<typeof parseArmadaInvite>>,
    token: Uint8Array,
    bootstrapRelays: string[]
  ): Promise<void> {
    // NOTE: do NOT check `root.isConnected` here — the element hasn't been
    // attached to the DOM yet (the caller appends it AFTER renderCard returns).
    // The isConnected checks after each await catch a later teardown.

    const filter = [
      {
        kinds: [INVITE_BUNDLE_KIND],
        authors: [invite.linkSigner],
        // d="" for invite bundles — use #d tag filter for precision.
        '#d': [''],
        limit: 1,
      },
    ];

    let events: NostrEvent[] = [];
    try {
      const transport = NostrTransport.getInstance();
      events = await transport.fetchDirect(
        bootstrapRelays,
        filter,
        ARMADA_FETCH_TIMEOUT_MS,
        'ArmadaInvite'
      );
    } catch (error) {
      diagLog('system', 'Armada invite: bundle fetch threw', {
        linkSigner: invite.linkSigner.slice(0, 8),
        error: String(error),
      });
    }

    if (!root.isConnected) return;

    if (!events.length) {
      ArmadaInviteRenderer.downgrade(root, invite, 'fetch-failed');
      diagLog('system', 'Armada invite: bundle not found on bootstrap relays', {
        linkSigner: invite.linkSigner.slice(0, 8),
        relays: bootstrapRelays,
      });
      return;
    }

    // Newest at the coordinate wins (a refresh replaces the bundle).
    const newest = events
      .slice()
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) {
      ArmadaInviteRenderer.downgrade(root, invite, 'fetch-failed');
      return;
    }
    const preview = decodeInviteBundle(newest, invite.linkSigner, token);
    if (!preview) {
      ArmadaInviteRenderer.downgrade(root, invite, 'fetch-failed');
      diagLog('system', 'Armada invite: bundle decode failed', {
        linkSigner: invite.linkSigner.slice(0, 8),
      });
      return;
    }

    const state: ArmadaCardState = preview.expired ? 'expired' : 'ready';
    diagLog('system', 'Armada invite: preview decrypted', {
      linkSigner: invite.linkSigner.slice(0, 8),
      name: preview.name,
      channelCount: preview.channelCount,
      hasIcon: !!preview.icon,
      expired: preview.expired,
    });

    if (!root.isConnected) return;
    root.className = `armada-invite armada-invite--${state}`;
    root.innerHTML = ArmadaInviteRenderer.cardHtml({
      state,
      name: preview.name,
      openUrl: invite.openUrl,
      preview,
    });
    ArmadaInviteRenderer.wireActions(root, invite.openUrl);
    void ArmadaInviteRenderer.loadIcon(root, preview);
  }

  /**
   * Async icon decrypt. Replaces the crest placeholder with the decrypted
   * image once it arrives. On any failure, leaves the crest in place.
   */
  private static async loadIcon(
    root: HTMLElement,
    preview: ArmadaInvitePreview
  ): Promise<void> {
    if (!preview.icon) return;
    const iconImg = root.querySelector<HTMLImageElement>('[data-armada-icon]');
    if (!iconImg) return;

    const controller = new AbortController();
    // If the card leaves the DOM, abort the in-flight image fetch.
    const observer = new MutationObserver(() => {
      if (!root.isConnected) {
        controller.abort();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const url = await decryptArmadaImage(preview.icon, controller.signal);
    observer.disconnect();
    if (!root.isConnected) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    if (url) {
      iconImg.src = url;
      iconImg.dataset.armadaIconLoaded = 'true';
      // Revoke once the browser has decoded the blob (frees memory).
      iconImg.addEventListener('load', () => URL.revokeObjectURL(url), {
        once: true,
      });
      iconImg.addEventListener('error', () => URL.revokeObjectURL(url), {
        once: true,
      });
    }
    // Failure → leave the crest fallback in place (already rendered).
  }

  /** Replace a loading card with the given non-loading state. */
  private static downgrade(
    root: HTMLElement,
    invite: NonNullable<ReturnType<typeof parseArmadaInvite>>,
    state: 'fetch-failed' | 'missing-secret'
  ): void {
    if (!root.isConnected) return;
    root.className = `armada-invite armada-invite--${state}`;
    root.innerHTML = ArmadaInviteRenderer.cardHtml({
      state,
      name: 'Encrypted community',
      openUrl: invite.openUrl,
    });
    ArmadaInviteRenderer.wireActions(root, invite.openUrl);
  }

  /** Wire the "Open in Armada" + copy-link buttons. */
  private static wireActions(root: HTMLElement, openUrl: string): void {
    const copyBtn = root.querySelector<HTMLButtonElement>('[data-armada-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', e => {
        // Inviolable media-click rule (see /build-validate Step 15): never
        // pre-empt a click on media. The copy button itself contains only
        // SVG icons, but be defensive — if the click bubbled here from an
        // <img>/<video> nested elsewhere in the card, leave it to the global
        // ImageClickHandler / VideoPlayerService.
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'IMG' ||
          target.tagName === 'VIDEO' ||
          target.closest('.note-media') ||
          target.closest('.note-image--clickable')
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .writeText(openUrl)
          .then(() => {
            copyBtn.dataset.armadaCopied = 'true';
            window.setTimeout(() => {
              delete copyBtn.dataset.armadaCopied;
            }, COPY_FEEDBACK_MS);
          })
          .catch(() => {
            /* clipboard blocked — silent */
          });
      });
    }
  }

  /** Pure HTML template for a card in any state. No external DOM deps. */
  private static cardHtml(opts: {
    state: ArmadaCardState;
    name: string;
    openUrl: string;
    preview?: ArmadaInvitePreview;
  }): string {
    const { state, name, openUrl, preview } = opts;
    const safeName = escapeHtml(name || 'Encrypted community');
    const safeUrl = escapeHtmlAttr(openUrl);

    // Channel-count line: shown only when we actually decrypted it.
    const metaBits: string[] = [];
    metaBits.push(`
      <span class="armada-invite__meta-bit">
        <svg width="12" height="12"><use href="#icon-lock"/></svg>
        <span>${
          state === 'missing-secret' || state === 'incomplete'
            ? 'Missing secret'
            : state === 'expired'
              ? 'Expired'
              : 'Encrypted'
        }</span>
      </span>
    `);
    if (preview && preview.channelCount > 0) {
      metaBits.push(`
        <span class="armada-invite__meta-bit">
          <svg width="12" height="12"><use href="#icon-grid-dots"/></svg>
          <span>${preview.channelCount} ${preview.channelCount === 1 ? 'channel' : 'channels'}</span>
        </span>
      `);
    }

    const nameBlock =
      state === 'loading'
        ? `<span class="armada-invite__name pulsate">Decrypting…</span>`
        : `<span class="armada-invite__name">${safeName}</span>`;

    const iconBlock = preview?.icon
      ? `<img data-armada-icon alt="" class="armada-invite__icon-img armada-invite__icon-img--hidden" />`
      : '';

    return `
      <div class="armada-invite__glow" aria-hidden="true"></div>
      <div class="armada-invite__body">
        <div class="armada-invite__eyebrow">
          <span class="armada-invite__brand">Armada</span>
          <span class="armada-invite__sep">·</span>
          <span class="armada-invite__kind">Community invite</span>
        </div>
        <div class="armada-invite__row">
          <div class="armada-invite__icon">
            ${iconBlock}
            <svg class="armada-invite__crest" width="28" height="28" aria-hidden="true"><use href="#icon-armada"/></svg>
          </div>
          <div class="armada-invite__info">
            ${nameBlock}
            <div class="armada-invite__meta">${metaBits.join('')}</div>
          </div>
        </div>
        <div class="armada-invite__actions">
          ${
            safeUrl
              ? `
            <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="btn armada-invite__open">
              <svg width="14" height="14"><use href="#icon-share-link"/></svg>
              <span>Open in Armada</span>
            </a>
            <button type="button" class="btn-icon armada-invite__copy" data-armada-copy aria-label="Copy invite link">
              <svg class="armada-invite__copy-icon" width="16" height="16"><use href="#icon-copy"/></svg>
              <svg class="armada-invite__copy-check" width="16" height="16"><use href="#icon-checkmark"/></svg>
            </button>
          `
              : ''
          }
        </div>
      </div>
    `;
  }
}
