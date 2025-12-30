/**
 * RepostRenderer - Renders repost notes (kind:6)
 * Handles both standard reposts and NIP-18 reposts
 * Extracts from: NoteUI.createRepostElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { NoteProcessor } from '../note-processing/NoteProcessor';
import { OriginalNoteRenderer } from './OriginalNoteRenderer';
import { ArticlePreviewRenderer } from '../../../services/ArticlePreviewRenderer';
import { CollapsibleManager } from '../note-features/CollapsibleManager';
import { QuoteOrchestrator } from '../../../services/orchestration/QuoteOrchestrator';
import { MuteOrchestrator } from '../../../services/orchestration/MuteOrchestrator';
import { AuthService } from '../../../services/AuthService';
import { hexToNpub } from '../../../helpers/nip19';
import { npubToUsername } from '../../../helpers/npubToUsername';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { UserHoverCard } from '../UserHoverCard';
import { ProfileRecognitionService } from '../../../services/ProfileRecognitionService';
import { ProfileBlinker, TextBlinker } from '../../../helpers/profileBlinking';

export class RepostRenderer {
  private static userProfileService = UserProfileService.getInstance();
  private static articlePreviewRenderer = ArticlePreviewRenderer.getInstance();
  private static recognitionService = ProfileRecognitionService.getInstance();
  private static authService = AuthService.getInstance();

  /**
   * Extract original event ID from repost tags
   */
  private static extractOriginalEventId(note: ProcessedNote): string | null {
    const eTags = note.rawEvent.tags.filter(tag => tag[0] === 'e');
    return eTags.length > 0 ? eTags[0][1] : null;
  }

  /**
   * Create repost element with "User reposted" display
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const repostDiv = document.createElement('div');
    repostDiv.className = 'note-card note-card--repost';
    repostDiv.dataset.eventId = note.id;
    repostDiv.dataset.noteType = 'repost';

    // Repost header showing who reposted
    const reposterPubkey = note.reposter?.pubkey || '';
    const reposterNpub = reposterPubkey ? hexToNpub(reposterPubkey) || '' : '';
    const reposterName = reposterNpub ? npubToUsername(reposterNpub) : 'Unknown';

    // Get profile picture (lightweight, non-blocking)
    const reposterPicture = reposterPubkey
      ? RepostRenderer.userProfileService.getProfilePicture(reposterPubkey)
      : '';

    const repostHeader = document.createElement('div');
    repostHeader.className = 'repost-header';
    repostHeader.innerHTML = `
      <span class="repost-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2l3 3-3 3m3-3H3M6 14l-3-3 3-3m-3 3h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="user-mention" data-pubkey="${reposterPubkey}">
        <a href="/profile/${reposterNpub}" class="mention-link" data-profile-pubkey="${reposterPubkey}">
          <img src="${reposterPicture}" alt="" class="profile-pic profile-pic--mini" /><span class="reposter-username"></span></a></span> reposted
    `;

    // Set initial username (may be npub if not cached)
    const usernameSpan = repostHeader.querySelector('.reposter-username') as HTMLElement;
    if (usernameSpan) {
      usernameSpan.textContent = reposterName;
    }

    // Store blinkers on the header element
    let avatarBlinker: ProfileBlinker | null = null;
    let nameBlinker: TextBlinker | null = null;

    // Subscribe to profile updates to refresh username AND avatar when loaded
    if (reposterPubkey) {
      RepostRenderer.userProfileService.subscribeToProfile(reposterPubkey, (profile) => {
        const newUsername = profile.display_name || profile.name || reposterNpub;
        const newPicture = profile.picture || '';
        const usernameEl = repostHeader.querySelector('.reposter-username') as HTMLElement;
        const avatarElement = repostHeader.querySelector('.profile-pic--mini') as HTMLImageElement;

        // Don't apply profile recognition to your own profile
        const currentUser = RepostRenderer.authService.getCurrentUser();
        const isOwnProfile = currentUser && currentUser.pubkey === reposterPubkey;

        // Profile Recognition logic
        const encounter = RepostRenderer.recognitionService.getEncounter(reposterPubkey);

        // Update last known metadata if changed
        if (encounter && (newUsername !== encounter.lastKnownName || newPicture !== encounter.lastKnownPictureUrl)) {
          RepostRenderer.recognitionService.updateLastKnown(reposterPubkey, newUsername, newPicture);
        }

        // Check if should blink (but not for own profile)
        const shouldBlink = !isOwnProfile && encounter && RepostRenderer.recognitionService.hasChangedWithinWindow(reposterPubkey);

        // Update username with blinking
        if (usernameEl) {
          if (shouldBlink && encounter) {
            // Initialize name blinker if needed
            if (!nameBlinker) {
              nameBlinker = new TextBlinker(usernameEl);
            }
            // Start blinking
            if (!nameBlinker.isBlinking()) {
              nameBlinker.start(newUsername, encounter.firstName);
            }
          } else {
            // Stop blinking or just set text
            if (nameBlinker && nameBlinker.isBlinking()) {
              nameBlinker.stop(newUsername);
            } else {
              usernameEl.textContent = newUsername;
            }
          }
        }

        // Update avatar with blinking
        if (avatarElement) {
          if (shouldBlink && encounter) {
            // Initialize avatar blinker if needed
            if (!avatarBlinker) {
              avatarBlinker = new ProfileBlinker(avatarElement);
            }
            // Start blinking
            if (!avatarBlinker.isBlinking()) {
              avatarBlinker.start(newPicture, encounter.firstPictureUrl);
            }
          } else {
            // Stop blinking or just set image
            if (avatarBlinker && avatarBlinker.isBlinking()) {
              avatarBlinker.stop(newPicture);
            } else if (newPicture) {
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
                CollapsibleManager.setup(repostDiv);
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
    } else if (note.repostedEvent.kind === 30023) {
      // Reposted event is a long-form article (kind:30023)
      const articleContainer = document.createElement('div');
      articleContainer.className = 'repost-article-container';

      // Generate naddr for the article
      const dTag = note.repostedEvent.tags.find(t => t[0] === 'd')?.[1] || '';
      const naddr = encodeNaddr({
        kind: note.repostedEvent.kind,
        pubkey: note.repostedEvent.pubkey,
        identifier: dTag,
        relays: []
      });

      // Render article preview
      RepostRenderer.articlePreviewRenderer.renderArticlePreview(`nostr:${naddr}`, articleContainer);

      repostDiv.appendChild(articleContainer);
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
              CollapsibleManager.setup(repostDiv);
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
          CollapsibleManager.setup(repostDiv);
        }
      }
    }

    return repostDiv;
  }
}
