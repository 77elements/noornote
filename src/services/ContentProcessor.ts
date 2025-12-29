/**
 * ContentProcessor Service
 * Shared content processing logic for NoteUI and SingleNoteView
 * Handles: media extraction, link extraction, hashtags, quoted refs, HTML formatting
 */

import { extractMedia } from '../helpers/extractMedia';
import { extractLinks } from '../helpers/extractLinks';
import { extractHashtags } from '../helpers/extractHashtags';
import { extractQuotedReferences } from '../helpers/extractQuotedReferences';
import { escapeHtml } from '../helpers/escapeHtml';
import { linkifyUrls } from '../helpers/linkifyUrls';
import { formatHashtags } from '../helpers/formatHashtags';
import { formatQuotedReferences } from '../helpers/formatQuotedReferences';
import { convertLineBreaks } from '../helpers/convertLineBreaks';
import { npubToUsername } from '../helpers/npubToUsername';
import { hexToNpub } from '../helpers/nip19';
import { UserProfileService } from './UserProfileService';
import type { MediaContent } from '../helpers/renderMediaContent';
import { ProfileRecognitionService } from './ProfileRecognitionService';
import { ProfileBlinker, TextBlinker } from '../helpers/profileBlinking';

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
}

export class ContentProcessor {
  private static instance: ContentProcessor;
  private userProfileService: UserProfileService;
  private recognitionService: ProfileRecognitionService;
  private profileCache: Map<string, any> = new Map();
  // Store blinkers per mention element (keyed by unique element ID)
  private mentionBlinkers: Map<string, { avatar: ProfileBlinker; name: TextBlinker }> = new Map();

  private constructor() {
    this.userProfileService = UserProfileService.getInstance();
    this.recognitionService = ProfileRecognitionService.getInstance();
  }

  static getInstance(): ContentProcessor {
    if (!ContentProcessor.instance) {
      ContentProcessor.instance = new ContentProcessor();
    }
    return ContentProcessor.instance;
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
    const media = extractMedia(text);
    const links = extractLinks(text);
    const hashtags = extractHashtags(text);
    const quotedRefs = extractQuotedReferences(text);

    const quotedReferences: QuotedReference[] = quotedRefs.map(ref => ({
      type: ref.type as 'event' | 'note' | 'addr',
      id: ref.id,
      fullMatch: ref.fullMatch
    }));

    // NON-BLOCKING: Trigger profile fetch for ALL p-tags in background
    const mentionTags = tags.filter(tag => tag[0] === 'p');
    if (mentionTags.length > 0) {
      const mentionPubkeys = mentionTags.map(tag => tag[1]);
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
      // Replace media URL with placeholder that we'll render later
      cleanedText = cleanedText.replace(item.url, `__MEDIA_${index}__`);
    });
    // Don't remove quoted references - they stay at their original position
    cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

    // Process HTML with individual helpers
    let html = escapeHtml(cleanedText);
    html = linkifyUrls(html);
    html = npubToUsername(html, 'html-multi', profileResolver);
    html = formatHashtags(html, hashtags);
    html = formatQuotedReferences(html, quotedReferences);
    html = convertLineBreaks(html);

    return {
      text,
      html,
      media,
      links,
      hashtags,
      quotedReferences
    };
  }

  /**
   * Get profile non-blocking with cache
   */
  getNonBlockingProfile(pubkey: string): any {
    if (this.profileCache.has(pubkey)) {
      return this.profileCache.get(pubkey);
    }

    const fallbackProfile = {
      pubkey,
      name: null,
      display_name: null,
      picture: '',
      about: null
    };

    this.profileCache.set(pubkey, fallbackProfile);

    this.userProfileService.getUserProfile(pubkey)
      .then(realProfile => {
        if (realProfile) {
          this.profileCache.set(pubkey, realProfile);
          // Update mentions in DOM after profile loads
          this.updateMentionsInDOM(pubkey, realProfile);
        }
      })
      .catch(_error => {
        console.warn(`Profile load failed for ${pubkey.slice(0, 8)}:`, _error);
      });

    return fallbackProfile;
  }

  /**
   * Update mentions in DOM after profile loads (progressive enhancement)
   * Applies profile recognition blinking if needed
   */
  private updateMentionsInDOM(hexPubkey: string, profile: any): void {
    const username = profile.name || profile.display_name;
    if (!username) return;

    // Convert hex to npub for profile URL
    const npub = hexToNpub(hexPubkey);
    const picture = profile.picture || '';

    // Profile Recognition logic
    const encounter = this.recognitionService.getEncounter(hexPubkey);

    // Update last known metadata if changed
    if (encounter && (username !== encounter.lastKnownName || picture !== encounter.lastKnownPictureUrl)) {
      this.recognitionService.updateLastKnown(hexPubkey, username, picture);
    }

    // Check if should blink
    const shouldBlink = encounter && this.recognitionService.hasChangedWithinWindow(hexPubkey);

    // Find all mention links for this profile (both loading and already loaded)
    const mentionLinks = document.querySelectorAll(`a[href="/profile/${npub}"][data-mention]`);

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

      if (shouldBlink && encounter && img && nameSpan) {
        // Get or create blinkers for this mention
        let blinkers = this.mentionBlinkers.get(mentionId);
        if (!blinkers) {
          blinkers = {
            avatar: new ProfileBlinker(img),
            name: new TextBlinker(nameSpan)
          };
          this.mentionBlinkers.set(mentionId, blinkers);
        }

        // Start blinking
        if (!blinkers.avatar.isBlinking()) {
          blinkers.avatar.start(picture, encounter.firstPictureUrl);
        }
        if (!blinkers.name.isBlinking()) {
          blinkers.name.start(username, encounter.firstName);
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
}
