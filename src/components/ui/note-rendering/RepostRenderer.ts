/**
 * RepostRenderer - Renders repost notes (kind:6)
 * Handles both standard reposts and NIP-18 reposts
 * Extracts from: NoteUI.createRepostElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { NoteProcessor } from '../note-processing/NoteProcessor';
import { OriginalNoteRenderer } from './OriginalNoteRenderer';
import { GitEventRenderer } from './GitEventRenderer';
import { HighlightRenderer } from './HighlightRenderer';
import { GIT_EVENT_KINDS } from '../../../types/nostr';
import { ArticlePreviewRenderer } from '../../../services/ArticlePreviewRenderer';
import { QuotedNoteRenderer } from '../../../services/QuotedNoteRenderer';
import { CollapsibleManager } from '../note-features/CollapsibleManager';
import { QuoteOrchestrator } from '../../../services/orchestration/QuoteOrchestrator';
import { MuteOrchestrator } from '../../../lists/mutes';
import { AuthService } from '../../../services/AuthService';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { hexToNpub } from '../../../helpers/nip19';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { UserHoverCard } from '../UserHoverCard';
import { Router } from '../../../services/Router';
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
   * Extract original event ID from repost tags
   */
  private static extractOriginalEventId(note: ProcessedNote): string | null {
    const eTags = note.rawEvent.tags.filter(tag => tag[0] === 'e');
    return eTags[0]?.[1] ?? null;
  }

  /**
   * Create repost element with "User reposted" display
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const repostDiv = document.createElement('div');
    repostDiv.className = 'note-card note-card--repost';
    repostDiv.dataset.eventId = note.id;
    repostDiv.dataset.noteType = 'repost';

    // Repost header showing who reposted. Pull render-ready values from the
    // profile cache: it always returns either real data or a deterministic
    // fallback (identicon / shortened npub). When the real profile arrives
    // the subscription below repaints both.
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

    // Set initial username (may be npub if not cached)
    const usernameSpan = repostHeader.querySelector('.reposter-username') as HTMLElement;
    if (usernameSpan) {
      usernameSpan.textContent = reposterName;
    }

    // Store blinkers on the header element (lazy-loaded types)
    let avatarBlinker: ProfileBlinkerType | null = null;
    let nameBlinker: TextBlinkerType | null = null;

    // Subscribe to profile updates. Profile-recognition runtime is looked up
    // fresh via AddonLoader each callback — no caching, so toggle OFF / account
    // switches are transparent (new runtime picked up automatically).
    if (reposterPubkey) {
      RepostRenderer.userProfileService.subscribeToProfile(reposterPubkey, (profile) => {
        const newUsername = UserProfileService.displayNameOf(profile, reposterPubkey);
        const newPicture = UserProfileService.displayPictureOf(profile, reposterPubkey);
        const usernameEl = repostHeader.querySelector('.reposter-username') as HTMLElement;
        const avatarElement = repostHeader.querySelector('.profile-pic--mini') as HTMLImageElement;

        // Profile Recognition: check if name/picture changed and should blink
        const rt = RepostRenderer.getRecognitionRuntime();
        const shouldBlink = rt?.service?.checkRecognition(reposterPubkey, newUsername, newPicture);

        // Update username with blinking
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

        // Update avatar with blinking
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

      // Setup UserHoverCard for the user-mention container
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

    // Check if we have the reposted event (standard repost) or need to fetch (NIP-18)
    if (!note.repostedEvent) {
      // NIP-18 repost: content is empty, need to fetch original event
      const originalEventId = RepostRenderer.extractOriginalEventId(note);

      if (originalEventId) {
        // Show placeholder while fetching
        const placeholderDiv = document.createElement('div');
        placeholderDiv.className = 'repost-loading-placeholder';
        placeholderDiv.innerHTML = `
          <div class="loading-content">
            <span class="loading-spinner">⏳</span>
            <span class="loading-text">Loading reposted note...</span>
          </div>
        `;
        repostDiv.appendChild(placeholderDiv);

        // Fetch original event via QuoteOrchestrator (async, non-blocking)
        const quoteOrchestrator = QuoteOrchestrator.getInstance();
        quoteOrchestrator.fetchQuotedEvent(originalEventId).then(async originalEvent => {
            if (originalEvent) {
              // Check if original author is muted
              const authService = AuthService.getInstance();
              const currentUser = authService.getCurrentUser();
              if (currentUser) {
                const muteOrchestrator = MuteOrchestrator.getInstance();
                const muteStatus = await muteOrchestrator.isMuted(originalEvent.pubkey, currentUser.pubkey);
                if (muteStatus.public || muteStatus.private) {
                  // Remove entire repost (muted users = invisible)
                  repostDiv.remove();
                  return;
                }
              }

              // Process the fetched event as a note
              const processedNote = NoteProcessor.process(originalEvent);

              // Create the original note element
              const originalNoteElement = OriginalNoteRenderer.render(processedNote, {
                ...opts,
                depth: opts.depth! + 1
              });

              // Replace placeholder with actual content
              placeholderDiv.replaceWith(originalNoteElement);

              // Setup collapsible if needed
              if (opts.depth === 0 && opts.collapsible) {
                CollapsibleManager.setup(repostDiv, { maxHeight: '40vh' });
              }
            } else {
              // Failed to fetch - show error
              placeholderDiv.innerHTML = `
                <div class="repost-error">
                  <span class="error-icon">⚠️</span>
                  <span class="error-text">Could not load reposted note</span>
                </div>
              `;
            }
        });
      } else {
        // No event ID in tags - show error
        const errorDiv = document.createElement('div');
        errorDiv.className = 'repost-error';
        errorDiv.innerHTML = `
          <span class="error-icon">⚠️</span>
          <span class="error-text">Invalid repost (no event reference)</span>
        `;
        repostDiv.appendChild(errorDiv);
      }
    } else if (note.repostedEvent.kind === 30402) {
      // Reposted event is a marketplace listing (kind:30402)
      const listingContainer = document.createElement('div');
      listingContainer.className = 'repost-article-container';
      const quotedNoteRenderer = QuotedNoteRenderer.getInstance();
      const dTag = getTag(note.repostedEvent.tags, 'd');
      const naddr = encodeNaddr({
        kind: 30402,
        pubkey: note.repostedEvent.pubkey,
        identifier: dTag,
        relays: []
      });
      quotedNoteRenderer.renderListingPreview(`nostr:${naddr}`, listingContainer);
      repostDiv.appendChild(listingContainer);
    } else if (note.repostedEvent.kind === 30023) {
      // Reposted event is a long-form article (kind:30023)
      const articleContainer = document.createElement('div');
      articleContainer.className = 'repost-article-container';

      // Generate naddr for the article
      const dTag = getTag(note.repostedEvent.tags, 'd');
      const naddr = encodeNaddr({
        kind: note.repostedEvent.kind,
        pubkey: note.repostedEvent.pubkey,
        identifier: dTag,
        relays: []
      });

      // Render article preview
      RepostRenderer.articlePreviewRenderer.renderArticlePreview(`nostr:${naddr}`, articleContainer);

      repostDiv.appendChild(articleContainer);
    } else if (note.repostedEvent.kind === 39089) {
      // Reposted event is a follow pack (kind:39089)
      const packContainer = document.createElement('div');
      packContainer.className = 'repost-article-container';

      const tags = note.repostedEvent.tags;
      const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
      const title = getTag('title') || getTag('n') || 'Untitled';
      const image = getTag('image');
      const memberCount = tags.filter(t => t[0] === 'p').length;

      const dTag = getTag('d');
      const naddr = encodeNaddr({
        kind: 39089,
        pubkey: note.repostedEvent.pubkey,
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
        Router.getInstance().navigate(`/follow-pack/${naddr}`);
      });

      repostDiv.appendChild(packContainer);
    } else if (note.repostedEvent.kind === 32267) {
      // Reposted event is a Zapstore app (kind:32267)
      const appContainer = document.createElement('div');
      appContainer.className = 'repost-article-container';

      const tags = note.repostedEvent.tags;
      const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
      const name = getTag('name') || 'Untitled App';
      const summary = getTag('summary');
      const icon = getTag('icon');

      const dTag = getTag('d');
      const naddr = encodeNaddr({
        kind: 32267,
        pubkey: note.repostedEvent.pubkey,
        identifier: dTag,
        relays: ['wss://relay.zapstore.dev']
      });

      appContainer.innerHTML = `
        <a href="/zapstore/${naddr}" class="repost-pack-preview" data-route="/zapstore/${naddr}">
          ${icon ? `<img src="${escapeHtmlAttr(icon)}" alt="" class="repost-pack-preview__image" loading="lazy" style="border-radius: 8px;" />` : ''}
          <div class="repost-pack-preview__info">
            <strong>${escapeHtml(name)}</strong>
            ${summary ? `<span>${escapeHtml(summary)}</span>` : ''}
          </div>
        </a>
      `;

      appContainer.querySelector('.repost-pack-preview')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.note-image--clickable, .note-media, video')) return;
        e.preventDefault();
        Router.getInstance().navigate(`/zapstore/${naddr}`);
      });

      repostDiv.appendChild(appContainer);
    } else if (note.repostedEvent.kind === 9802) {
      // Reposted event is a NIP-84 highlight (kind:9802)
      const highlightContainer = document.createElement('div');
      highlightContainer.className = 'repost-article-container';
      const processedHighlight = NoteProcessor.process(note.repostedEvent);
      const highlightElement = HighlightRenderer.render(processedHighlight, { collapsible: false, depth: (opts.depth ?? 0) + 1 });
      highlightContainer.appendChild(highlightElement);
      repostDiv.appendChild(highlightContainer);
    } else if (note.repostedEvent.kind !== undefined && GIT_EVENT_KINDS.includes(note.repostedEvent.kind)) {
      // Reposted event is a NIP-34 git event (Patch / PR / Issue / Status / Repo)
      const gitContainer = document.createElement('div');
      gitContainer.className = 'repost-article-container';
      const processedGit = NoteProcessor.process(note.repostedEvent);
      const gitElement = GitEventRenderer.render(processedGit, { collapsible: false, depth: (opts.depth ?? 0) + 1 });
      gitContainer.appendChild(gitElement);
      repostDiv.appendChild(gitContainer);
    } else {
      // Standard repost: Original note content with original author (depth > 0 to prevent double collapsible)
      // Check if original author is muted (async check)
      const authService = AuthService.getInstance();
      const currentUser = authService.getCurrentUser();

      // Create placeholder first
      const contentPlaceholder = document.createElement('div');
      contentPlaceholder.className = 'repost-content-loading';
      repostDiv.appendChild(contentPlaceholder);

      // Async mute check
      if (currentUser && note.repostedEvent) {
        const muteOrchestrator = MuteOrchestrator.getInstance();
        muteOrchestrator.isMuted(note.repostedEvent.pubkey, currentUser.pubkey).then(muteStatus => {
          if (muteStatus.public || muteStatus.private) {
            // Remove entire repost (muted users = invisible)
            repostDiv.remove();
          } else {
            // Render original note
            const originalNoteElement = OriginalNoteRenderer.render(note, {
              ...opts,
              depth: opts.depth! + 1
            });
            contentPlaceholder.replaceWith(originalNoteElement);

            // Setup collapsible for long reposts (only for top-level reposts)
            if (opts.depth === 0 && opts.collapsible) {
              CollapsibleManager.setup(repostDiv, { maxHeight: '40vh' });
            }
          }
        });
      } else {
        // No current user, render normally
        const originalNoteElement = OriginalNoteRenderer.render(note, {
          ...opts,
          depth: opts.depth! + 1
        });
        contentPlaceholder.replaceWith(originalNoteElement);

        // Setup collapsible for long reposts (only for top-level reposts)
        if (opts.depth === 0 && opts.collapsible) {
          CollapsibleManager.setup(repostDiv, { maxHeight: '40vh' });
        }
      }
    }

    return repostDiv;
  }
}
