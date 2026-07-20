/**
 * RepostRenderer - Renders repost notes (kind:6 / kind:16)
 *
 * Amethyst-pattern: the inner event is dispatched through the standard
 * {@link NoteProcessor} + {@link NoteRendererFactory} pipeline — the same path
 * top-level events take. Special-case branches are kept only for the bespoke
 * "preview card" kinds (Follow-Pack, Ditto geocache) and the addressable
 * kinds routed through ArticlePreviewRenderer (article, Zapstore app, live
 * stream). Any future content kind that grows a Processor/Renderer pair starts
 * working in reposts automatically without touching this file.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { UserProfileService } from '../../../services/UserProfileService';
import { NoteProcessor } from '../note-processing/NoteProcessor';
import { NoteRendererFactory } from './NoteRendererFactory';
import { DittoFeatureRenderer, DITTO_GEOCACHE_KIND } from './DittoFeatureRenderer';
import { ARTICLE_PREVIEW_KINDS } from '../../../helpers/addressableKinds';
import { ArticlePreviewRenderer } from './ArticlePreviewRenderer';
import { CollapsibleManager } from '../note-features/CollapsibleManager';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../../modules/single-note/contracts';
import { MuteOrchestrator } from '../../../lists/mutes';
import { AuthService } from '../../../services/AuthService';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { hexToNpub } from '../../../helpers/nip19';
import { encodeNaddr, encodeNevent } from '../../../services/NostrToolsAdapter';
import { UserHoverCard } from '../UserHoverCard';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { AddonLoader } from '../../../addons/AddonLoader';
import type { ProfileRecognitionRuntime } from '../../../addons/profile-recognition/runtime';
import { getTag } from '../../../helpers/tagUtils';

// Types only (erased at build time) — live runtime accessed via AddonLoader
type ProfileBlinkerType = import('../../../addons/profile-recognition/profileBlinking').ProfileBlinker;
type TextBlinkerType = import('../../../addons/profile-recognition/profileBlinking').TextBlinker;

export class RepostRenderer {
  private static userProfileService = UserProfileService.getInstance();
  private static articlePreviewRenderer = ArticlePreviewRenderer.getInstance();

  private static getRecognitionRuntime(): ProfileRecognitionRuntime | null {
    return AddonLoader.getInstance().getRuntime<ProfileRecognitionRuntime>('profile-recognition');
  }

  /**
   * Extract original event id + relay hint from the kind:6 e-tag.
   * NIP-18 puts the relay where the original lives at position [2] — without it,
   * cross-relay reposts (e.g. ditto.pub originals shown via our read set) can't be resolved.
   */
  private static extractOriginalEventRef(note: ProcessedNote): { id: string; relayHint: string } | null {
    const eTag = note.rawEvent.tags.find(tag => tag[0] === 'e');
    if (!eTag?.[1]) return null;
    return { id: eTag[1], relayHint: eTag[2] || '' };
  }

  /**
   * Create repost element with "User reposted" display.
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const repostDiv = document.createElement('div');
    repostDiv.className = 'note-card note-card--repost';
    repostDiv.dataset.eventId = note.id;
    repostDiv.dataset.noteType = 'repost';

    RepostRenderer.buildRepostHeader(repostDiv, note);

    if (!note.repostedEvent) {
      // NIP-18 repost: content is empty, need to fetch original event
      RepostRenderer.handleNip18Fetch(repostDiv, note, opts);
    } else {
      // Embedded repost: dispatch the inner event through the standard pipeline.
      // Mute check fires async; on positive mute the entire repost is removed.
      RepostRenderer.attachMuteCheck(repostDiv, note.repostedEvent.pubkey);
      RepostRenderer.dispatchInnerEvent(repostDiv, note.repostedEvent, opts);
    }

    return repostDiv;
  }

  /**
   * Build the "user reposted" header (avatar + name + "reposted" label),
   * wire profile-recognition blinkers + hover card.
   */
  private static buildRepostHeader(repostDiv: HTMLElement, note: ProcessedNote): void {
    const reposterPubkey = note.reposter?.pubkey || '';
    const reposterNpub = reposterPubkey ? hexToNpub(reposterPubkey) || '' : '';
    const reposterName = reposterPubkey
      ? RepostRenderer.userProfileService.getDisplayName(reposterPubkey)
      : 'Unknown';
    const reposterPicture = reposterPubkey
      ? RepostRenderer.userProfileService.getDisplayPicture(reposterPubkey)
      : '';

    const repostHeader = document.createElement('div');
    repostHeader.className = 'repost-header';
    repostHeader.innerHTML = `
      <span class="repost-icon"><svg width="16" height="16"><use href="#icon-repost"/></svg></span>
      <span class="user-mention" data-pubkey="${reposterPubkey}">
        <a href="/profile/${reposterNpub}" class="mention-link" data-profile-pubkey="${reposterPubkey}">
          <img src="${escapeHtmlAttr(reposterPicture)}" alt="" data-pubkey="${reposterPubkey}" class="profile-pic profile-pic--mini" /><span class="reposter-username"></span></a></span><span class="repost-label">reposted</span>
    `;

    const usernameSpan = repostHeader.querySelector('.reposter-username') as HTMLElement;
    if (usernameSpan) {
      usernameSpan.textContent = reposterName;
    }

    // Store blinkers on the header element (lazy-loaded types)
    let avatarBlinker: ProfileBlinkerType | null = null;
    let nameBlinker: TextBlinkerType | null = null;

    if (reposterPubkey) {
      RepostRenderer.userProfileService.subscribeToProfile(reposterPubkey, (profile) => {
        const newUsername = UserProfileService.displayNameOf(profile, reposterPubkey);
        const newPicture = UserProfileService.displayPictureOf(profile, reposterPubkey);
        const usernameEl = repostHeader.querySelector('.reposter-username') as HTMLElement;
        const avatarElement = repostHeader.querySelector('.profile-pic--mini') as HTMLImageElement;

        const rt = RepostRenderer.getRecognitionRuntime();
        const shouldBlink = rt?.service?.checkRecognition(reposterPubkey, newUsername, newPicture);

        if (usernameEl) {
          if (shouldBlink) {
            if (!nameBlinker && rt?.TextBlinker) {
              nameBlinker = new rt.TextBlinker(usernameEl);
            }
            if (nameBlinker && !nameBlinker.isBlinking()) {
              nameBlinker.start(newUsername, shouldBlink.firstName);
            }
          } else {
            if (nameBlinker && nameBlinker.isBlinking()) {
              nameBlinker.stop(newUsername);
            } else {
              usernameEl.textContent = newUsername;
            }
          }
        }

        if (avatarElement) {
          if (shouldBlink) {
            if (!avatarBlinker && rt?.ProfileBlinker) {
              avatarBlinker = new rt.ProfileBlinker(avatarElement);
            }
            if (avatarBlinker && !avatarBlinker.isBlinking()) {
              avatarBlinker.start(newPicture, shouldBlink.firstPictureUrl);
            }
          } else {
            if (avatarBlinker && avatarBlinker.isBlinking()) {
              avatarBlinker.stop(newPicture);
            } else {
              avatarElement.src = newPicture;
            }
          }
        }
      });

      const userHoverCard = UserHoverCard.getInstance();
      const userMention = repostHeader.querySelector('.user-mention') as HTMLElement;

      if (userMention) {
        userMention.addEventListener('mouseenter', () => {
          userHoverCard.show(reposterPubkey, userMention);
        });
        userMention.addEventListener('mouseleave', () => {
          userHoverCard.hide();
        });
      }
    }

    repostDiv.appendChild(repostHeader);
  }

  /**
   * Fire-and-forget mute check. Removes the repost from the DOM if the inner
   * event's author is muted. Mirrors the previous behaviour where mute checks
   * were scattered across the various kind branches; consolidated here so every
   * kind benefits uniformly.
   */
  private static attachMuteCheck(repostDiv: HTMLElement, authorPubkey: string): void {
    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();
    if (!currentUser) return;
    MuteOrchestrator.getInstance().isMuted(authorPubkey, currentUser.pubkey).then(muteStatus => {
      if (muteStatus.public || muteStatus.private) {
        repostDiv.remove();
      }
    }).catch(() => { /* leave the repost visible on mute-check failure */ });
  }

  /**
   * NIP-18 repost: the inner event isn't embedded in the content, so fetch it
   * via QuoteOrchestrator (hint + read set + outbox of author and reposter).
   * On success, dispatch through the same pipeline as embedded reposts.
   */
  private static handleNip18Fetch(repostDiv: HTMLElement, note: ProcessedNote, opts: NoteUIOptions): void {
    const originalRef = RepostRenderer.extractOriginalEventRef(note);

    if (!originalRef) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'repost-error';
      errorDiv.innerHTML = `
        <span class="error-icon">⚠️</span>
        <span class="error-text">Invalid repost (no event reference)</span>
      `;
      repostDiv.appendChild(errorDiv);
      return;
    }

    const placeholderDiv = document.createElement('div');
    placeholderDiv.className = 'repost-loading-placeholder';
    placeholderDiv.innerHTML = `
      <div class="loading-content">
        <span class="loading-spinner">⏳</span>
        <span class="loading-text">Loading reposted note...</span>
      </div>
    `;
    repostDiv.appendChild(placeholderDiv);

    // Wrap (id + e-tag relay hint + author p-tag) into an nevent so QuoteOrchestrator's
    // stage-1 hint fetch fires — bare hex id would skip straight to our read relays.
    const authorPubkey = note.author?.pubkey;
    const reposterPubkey = note.rawEvent.pubkey;
    const neventRef = encodeNevent(
      originalRef.id,
      originalRef.relayHint ? [originalRef.relayHint] : [],
      authorPubkey
    );

    // Stage-3 outbound includes BOTH the original author AND the reposter.
    const singleNoteApi = ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
    (singleNoteApi?.fetchQuotedEvent(`nostr:${neventRef}`, authorPubkey, [reposterPubkey]) ?? Promise.resolve(null))
      .then(originalEvent => {
        if (!originalEvent) {
          placeholderDiv.innerHTML = `
            <div class="repost-error">
              <span class="error-icon">⚠️</span>
              <span class="error-text">Could not load reposted note</span>
            </div>
          `;
          return;
        }
        placeholderDiv.remove();
        RepostRenderer.attachMuteCheck(repostDiv, originalEvent.pubkey);
        RepostRenderer.dispatchInnerEvent(repostDiv, originalEvent, opts);
      });
  }

  /**
   * Dispatch an embedded (or just-fetched) inner event through the rendering
   * pipeline. Three branches:
   *
   *  1. Bespoke preview-card kinds (Follow-Pack, Ditto geocache) — kept inline
   *     because they don't have a Processor/Renderer pair.
   *  2. Addressable article-preview kinds (article / Zapstore app / live stream)
   *     — routed through {@link ArticlePreviewRenderer.renderFromEvent}.
   *  3. Everything else — processed through the standard
   *     {@link NoteProcessor} + {@link NoteRendererFactory} pipeline, so any
   *     future content kind works in reposts automatically.
   */
  private static dispatchInnerEvent(
    repostDiv: HTMLElement,
    innerEvent: NostrEvent,
    opts: NoteUIOptions
  ): void {
    // (1) Ditto geocache (kind 37516): proprietary, no NIP. No Processor/Renderer pair.
    if (innerEvent.kind === DITTO_GEOCACHE_KIND) {
      const dittoContainer = document.createElement('div');
      dittoContainer.className = 'repost-article-container';
      dittoContainer.appendChild(DittoFeatureRenderer.render(innerEvent));
      repostDiv.appendChild(dittoContainer);
      return;
    }

    // (1) Follow pack (kind 39089): bespoke preview card, no Processor/Renderer pair.
    if (innerEvent.kind === 39089) {
      RepostRenderer.renderFollowPackPreview(repostDiv, innerEvent);
      return;
    }

    // (2) Addressable article-preview kinds (30023 article, 32267 Zapstore
    //     app, 30311 live stream). All share the ArticlePreviewRenderer pipeline
    //     and are listed in ARTICLE_PREVIEW_KINDS as the single source of truth.
    if (innerEvent.kind != null && ARTICLE_PREVIEW_KINDS.has(innerEvent.kind)) {
      const container = document.createElement('div');
      container.className = 'repost-article-container';
      RepostRenderer.articlePreviewRenderer.renderFromEvent(innerEvent, container);
      repostDiv.appendChild(container);
      return;
    }

    // (3) Generic dispatch through the standard pipeline.
    const processedInner = NoteProcessor.process(innerEvent);
    const innerElement = NoteRendererFactory.render(processedInner, {
      ...opts,
      depth: (opts.depth ?? 0) + 1
    });

    const innerContainer = document.createElement('div');
    innerContainer.className = 'repost-content-container';
    innerContainer.appendChild(innerElement);
    repostDiv.appendChild(innerContainer);

    if (opts.depth === 0 && opts.collapsible) {
      CollapsibleManager.setup(repostDiv, { maxHeight: '40vh', contentSelector: '.note-card--original' });
    }
  }

  /**
   * Bespoke preview card for NIP-??? community "follow packs" (kind 39089).
   * Kept inline because the card markup has no Processor/Renderer equivalent
   * (the FollowPackRenderer renders the full feed view, not the preview).
   */
  private static renderFollowPackPreview(repostDiv: HTMLElement, event: NostrEvent): void {
    const packContainer = document.createElement('div');
    packContainer.className = 'repost-article-container';

    const tags = event.tags;
    const title = getTag(tags, 'title') || getTag(tags, 'n') || 'Untitled';
    const image = getTag(tags, 'image');
    const memberCount = tags.filter(t => t[0] === 'p').length;

    const dTag = getTag(tags, 'd');
    const naddr = encodeNaddr({
      kind: 39089,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: []
    });

    packContainer.innerHTML = `
      <a href="/follow-pack/${naddr}" class="repost-pack-preview" data-route="/follow-pack/${naddr}">
        ${image ? `<img src="${escapeHtmlAttr(image)}" alt="" class="repost-pack-preview__image" loading="lazy" />` : ''}
        <div class="repost-pack-preview__info">
          <strong>${escapeHtml(title)}</strong>
          <span>${memberCount} people</span>
        </div>
      </a>
    `;

    packContainer.querySelector('.repost-pack-preview')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.note-image--clickable, .note-media, video')) return;
      e.preventDefault();
      getViewNavigationController().openView('follow-pack', naddr, e as MouseEvent);
    });

    repostDiv.appendChild(packContainer);
  }
}
