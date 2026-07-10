/**
 * ContentProcessor Service
 * Shared content processing logic for NoteUI and SingleNoteView
 * Handles: media extraction, link extraction, hashtags, quoted refs, HTML formatting
 */

import { extractMedia } from '../helpers/extractMedia';
import { extractBolt11, type Bolt11Match } from '../helpers/extractBolt11';
import { unwrapStreamLinks } from '../helpers/unwrapStreamLinks';
import { unwrapGitLinks } from '../helpers/unwrapGitLinks';
import { extractLinks } from '../helpers/extractLinks';
import { extractHashtags } from '../helpers/extractHashtags';
import { extractQuotedReferences } from '../helpers/extractQuotedReferences';
import { escapeHtml } from '../helpers/escapeHtml';
import { linkifyUrls } from '../helpers/linkifyUrls';
import { formatHashtags } from '../helpers/formatHashtags';
import { formatQuotedReferences } from '../helpers/formatQuotedReferences';
import { convertLineBreaks } from '../helpers/convertLineBreaks';
import { npubToUsername } from '../helpers/npubToUsername';
import { extractCustomEmojis, formatCustomEmojis } from '../helpers/formatCustomEmojis';
import { hexToNpub } from '../helpers/nip19';
import { UserProfileService } from './UserProfileService';
import type { MediaContent } from '../helpers/renderMediaContent';
import { AddonLoader } from '../addons/AddonLoader';
import type { ProfileRecognitionRuntime } from '../addons/profile-recognition/runtime';
import type { ProfileBlinker as ProfileBlinkerT, TextBlinker as TextBlinkerT } from '../addons/profile-recognition/profileBlinking';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

export interface QuotedReference {
  type: 'event' | 'note' | 'addr';
  id: string;
  fullMatch: string;
}

export interface ProcessedContent {
  text: string;
  html: string;
  media: MediaContent[];
  links: any[];
  hashtags: string[];
  quotedReferences: QuotedReference[];
  bolt11Invoices: Bolt11Match[];
}

export class ContentProcessor {
  private static instance: ContentProcessor;
  private userProfileService: UserProfileService;
  private profileCache: LRUCache<any> = new LRUCache<any>(getCacheSize(500, 200, 100));

  // Profile Recognition blinker instances, keyed by mention element id.
  // The ProfileRecognitionService + blinker classes now live in the addon
  // runtime; we look them up fresh via AddonLoader at use time. Blinker
  // instances themselves are still tracked here because they are tied to
  // the DOM nodes this processor updates.
  private mentionBlinkers: Map<string, { avatar: ProfileBlinkerT; name: TextBlinkerT; el: HTMLElement }> = new Map();
  // Periodic sweep that destroys blinkers whose mention element has left the DOM
  // (feed trimming / view teardown). Without it the map + the blinkers' 2s
  // intervals grow unbounded and pin detached DOM nodes. Lazily started on the
  // first blinker, stopped when the map empties.
  private blinkerSweepInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly BLINKER_SWEEP_MS = 20000;

  private constructor() {
    this.userProfileService = UserProfileService.getInstance();
    // Patch mention chips whenever ANY profile arrives — covers profiles that
    // were filled by another path (UserHoverCard, NoteHeader, RepostRenderer)
    // and would otherwise leave the chip stuck on the loading placeholder.
    this.userProfileService.subscribeToAnyProfileUpdate((pubkey, profile) => {
      this.updateMentionsInDOM(pubkey, profile);
    });
  }

  static getInstance(): ContentProcessor {
    if (!ContentProcessor.instance) {
      ContentProcessor.instance = new ContentProcessor();
    }
    return ContentProcessor.instance;
  }

  /** Fetch the current profile-recognition runtime, or null if addon is OFF/not-yet-loaded. */
  private getRecognitionRuntime(): ProfileRecognitionRuntime | null {
    return AddonLoader.getInstance().getRuntime<ProfileRecognitionRuntime>('profile-recognition');
  }

  /**
   * Process content without tags
   */
  processContent(text: string): ProcessedContent {
    return this.processContentWithTags(text, []);
  }

  /**
   * Process content with tags (for mention profile loading)
   * SYNCHRONOUS - no blocking calls
   */
  processContentWithTags(text: string, tags: string[][]): ProcessedContent {
    // Unwrap known-host URLs to raw nostr:... so they're picked up by
    // extractQuotedReferences below. Streams (zap.stream/...) are
    // provider-agnostic; git (gitworkshop.dev) is host-whitelisted to avoid
    // false positives on arbitrary URLs that happen to end in NIP-19.
    text = unwrapStreamLinks(text);
    text = unwrapGitLinks(text);

    const media = extractMedia(text);
    const links = extractLinks(text);
    const hashtags = extractHashtags(text);
    const quotedRefs = extractQuotedReferences(text);
    const bolt11Invoices = extractBolt11(text);

    const quotedReferences: QuotedReference[] = quotedRefs.map(ref => ({
      type: ref.type as 'event' | 'note' | 'addr',
      id: ref.id,
      fullMatch: ref.fullMatch
    }));

    // NON-BLOCKING: Trigger profile fetch for ALL p-tags in background
    const mentionTags = tags.filter(tag => tag[0] === 'p');
    if (mentionTags.length > 0) {
      const mentionPubkeys = mentionTags.map(tag => tag[1]).filter((p): p is string => !!p);
      this.userProfileService.getUserProfiles(mentionPubkeys).then(profiles => {
        profiles.forEach((profile, pubkey) => {
          this.profileCache.set(pubkey, profile);
          // Update DOM immediately when profile loads
          this.updateMentionsInDOM(pubkey, profile);
        });
      }).catch(err => console.warn('Failed to load mention profiles:', err));
    }

    // Profile resolver for mentions
    const profileResolver = (hexPubkey: string) => {
      const profile = this.getNonBlockingProfile(hexPubkey);
      return profile ? {
        name: profile.name,
        display_name: profile.display_name,
        picture: profile.picture
      } : null;
    };

    // Replace media URLs with placeholders (keep them at original position)
    let cleanedText = text;
    media.forEach((item, index) => {
      // Replace original URL (with tracking params) from text with placeholder
      const urlToReplace = item.originalUrl || item.url;
      cleanedText = cleanedText.replace(urlToReplace, `__MEDIA_${index}__`);
    });
    // Replace bolt11 invoices with placeholders
    bolt11Invoices.forEach((item, index) => {
      cleanedText = cleanedText.replace(item.fullMatch, `__BOLT11_${index}__`);
    });
    // Don't remove quoted references - they stay at their original position
    cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

    // Extract custom emojis from tags (NIP-30)
    const customEmojis = extractCustomEmojis(tags);

    // Process HTML with individual helpers
    let html = escapeHtml(cleanedText);
    html = linkifyUrls(html);
    html = npubToUsername(html, 'html-multi', profileResolver);
    html = formatHashtags(html, hashtags);
    html = formatQuotedReferences(html, quotedReferences);
    // Quote markers are replaced by block-level cards (quote box / article
    // preview / git event card). They don't need <br>s wrapped around them —
    // strip adjacent newlines so convertLineBreaks below doesn't add extra
    // vertical space (matches Jumble/Amethyst spacing around inline quotes).
    html = html.replace(/\n*(<span class="quote-marker"[^>]*><\/span>)\n*/g, '$1');
    html = formatCustomEmojis(html, customEmojis);
    html = convertLineBreaks(html);

    return {
      text,
      html,
      media,
      links,
      hashtags,
      quotedReferences,
      bolt11Invoices
    };
  }

  /**
   * Get profile non-blocking with cache
   *
   * Single source of truth: UserProfileService.profileCache. The private
   * profileCache here is only a secondary read-through cache — never a
   * substitute for UPS. Previously this method checked ONLY its own cache
   * and cached a {name:null} fallback permanently, which shadowed the real
   * profile already in UPS and left mention chips stuck on npub/"…" even
   * though the data was available.
   */
  getNonBlockingProfile(pubkey: string): any {
    // 1. Authoritative source first — UPS may already have the profile
    //    (loaded by NoteHeader, UserHoverCard, RepostRenderer, etc.).
    const upsProfile = this.userProfileService.getCachedProfile(pubkey);
    if (upsProfile) {
      this.profileCache.set(pubkey, upsProfile);
      return upsProfile;
    }

    // 2. Secondary cache (may hold a profile populated by a prior batch fetch)
    if (this.profileCache.has(pubkey)) {
      const cached = this.profileCache.get(pubkey);
      // Only return if it has real data — skip stale null fallbacks
      if (cached && (cached.name || cached.display_name)) {
        return cached;
      }
    }

    // 3. No real data anywhere — return a temporary placeholder and fetch.
    //    Do NOT cache the null fallback (it would shadow future UPS resolves).
    const placeholderProfile = {
      pubkey,
      name: null,
      display_name: null,
      picture: '',
      about: null
    };

    this.userProfileService.getUserProfile(pubkey)
      .then(realProfile => {
        if (realProfile && (realProfile.name || realProfile.display_name)) {
          this.profileCache.set(pubkey, realProfile);
          this.updateMentionsInDOM(pubkey, realProfile);
        }
      })
      .catch(_error => {
        console.debug(`Profile load failed for ${pubkey.slice(0, 8)}:`, _error);
      });

    return placeholderProfile;
  }

  /**
   * Update mentions in DOM after profile loads (progressive enhancement)
   * Applies profile recognition blinking if addon is loaded
   */
  private updateMentionsInDOM(hexPubkey: string, profile: any): void {
    // Convert hex to npub for profile URL
    const npub = hexToNpub(hexPubkey);
    if (!npub) return;

    // Bail early if no mention chips for this pubkey are in the DOM — the
    // global subscription fires for every profile update, so most calls have
    // nothing to patch. querySelectorAll(...) is the cheapest filter.
    const mentionLinks = document.querySelectorAll(`a[href="/profile/${npub}"][data-mention]`);
    if (mentionLinks.length === 0) return;

    // Render-ready values from the cache (real or fallback — see UserProfileService).
    const rawUsername = profile.name || profile.display_name;
    const username = UserProfileService.displayNameOf(profile, hexPubkey);
    const picture = UserProfileService.displayPictureOf(profile, hexPubkey);

    // Profile Recognition: check if name/picture changed and should blink.
    // Runtime lookup is fresh per call — if the addon was toggled off or
    // reinitialized for a new account, we transparently pick up the new state.
    const recognitionRuntime = this.getRecognitionRuntime();
    const shouldBlink = rawUsername
      ? recognitionRuntime?.service?.checkRecognition(hexPubkey, username, picture)
      : null;

    mentionLinks.forEach((link) => {
      const linkElement = link as HTMLAnchorElement;
      const img = linkElement.querySelector('img') as HTMLImageElement;

      // Get or create text container span (needed for blinking)
      let nameSpan = linkElement.querySelector('.mention-name') as HTMLElement;
      if (!nameSpan) {
        // Wrap existing text node or create new span
        const textNode = Array.from(linkElement.childNodes).find(node => node.nodeType === Node.TEXT_NODE) as Text | undefined;
        nameSpan = document.createElement('span');
        nameSpan.className = 'mention-name';
        nameSpan.textContent = textNode?.textContent || '';

        if (textNode) {
          linkElement.replaceChild(nameSpan, textNode);
        } else {
          linkElement.appendChild(nameSpan);
        }
      }

      // Create a unique ID for this mention element if it doesn't have one
      if (!linkElement.dataset.mentionId) {
        linkElement.dataset.mentionId = `mention-${Math.random().toString(36).substr(2, 9)}`;
      }
      const mentionId = linkElement.dataset.mentionId;

      if (shouldBlink && img && nameSpan && recognitionRuntime?.ProfileBlinker && recognitionRuntime.TextBlinker) {
        // Get or create blinkers for this mention
        let blinkers = this.mentionBlinkers.get(mentionId);
        if (!blinkers) {
          blinkers = {
            avatar: new recognitionRuntime.ProfileBlinker(img),
            name: new recognitionRuntime.TextBlinker(nameSpan),
            el: linkElement
          };
          this.mentionBlinkers.set(mentionId, blinkers);
          this.ensureBlinkerSweep();
        }

        // Start blinking
        if (!blinkers.avatar.isBlinking()) {
          blinkers.avatar.start(picture, shouldBlink.firstPictureUrl);
        }
        if (!blinkers.name.isBlinking()) {
          blinkers.name.start(username, shouldBlink.firstName);
        }
      } else {
        // Stop blinking or update normally
        const blinkers = this.mentionBlinkers.get(mentionId);
        if (blinkers) {
          if (blinkers.avatar.isBlinking()) {
            blinkers.avatar.stop(picture);
          }
          if (blinkers.name.isBlinking()) {
            blinkers.name.stop(username);
          }
        } else {
          // No blinkers, just update directly
          if (img) {
            img.src = picture;
          }
          if (nameSpan) {
            nameSpan.textContent = username;
          }
        }
      }

      // Remove loading indicator
      linkElement.removeAttribute('data-loading');
    });
  }

  /** Start the detached-blinker sweep once (lazy, on the first blinker). */
  private ensureBlinkerSweep(): void {
    if (this.blinkerSweepInterval) return;
    this.blinkerSweepInterval = setInterval(() => this.pruneDetachedBlinkers(), ContentProcessor.BLINKER_SWEEP_MS);
  }

  /**
   * Destroy + drop blinkers whose mention element is no longer in the DOM
   * (clears their 2s intervals and releases the pinned DOM nodes). Stops the
   * sweep timer once nothing is left to track.
   */
  private pruneDetachedBlinkers(): void {
    for (const [id, b] of this.mentionBlinkers) {
      if (!b.el.isConnected) {
        b.avatar.destroy();
        b.name.destroy();
        this.mentionBlinkers.delete(id);
      }
    }
    if (this.mentionBlinkers.size === 0 && this.blinkerSweepInterval) {
      clearInterval(this.blinkerSweepInterval);
      this.blinkerSweepInterval = null;
    }
  }

  /**
   * Stop + destroy ALL mention blinkers and the sweep timer. Called when the
   * Profile Recognition addon is torn down (toggle off / account switch) so its
   * blink intervals don't keep firing against stale DOM after the addon is gone.
   */
  public clearAllBlinkers(): void {
    for (const b of this.mentionBlinkers.values()) {
      b.avatar.destroy();
      b.name.destroy();
    }
    this.mentionBlinkers.clear();
    if (this.blinkerSweepInterval) {
      clearInterval(this.blinkerSweepInterval);
      this.blinkerSweepInterval = null;
    }
  }
}
