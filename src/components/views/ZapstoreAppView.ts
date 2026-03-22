/**
 * ZapstoreAppView - Displays a Zapstore app listing (kind 32267)
 * Loaded via /zapstore/:naddr route.
 * Shows app details, screenshots, release info, ISL, and replies.
 */

import { View } from './View';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { SystemLogger } from '../system/SystemLogger';
import { PlatformService } from '../../services/PlatformService';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { RepliesRenderer } from '../replies/RepliesRenderer';
import { decodeNip19, encodeNaddr } from '../../services/NostrToolsAdapter';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { renderUserMention, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { UserProfileService } from '../../services/UserProfileService';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const ZAPSTORE_RELAY = 'wss://relay.zapstore.dev';

interface ZapstoreApp {
  identifier: string;
  name: string;
  summary: string;
  description: string;
  icon: string;
  images: string[];
  license: string;
  repository: string;
  url: string;
  platform: string;
  topics: string[];
  pubkey: string;
}

interface ReleaseInfo {
  version: string;
  releaseNotes: string;
  fileSize: number;
  versionCode: string;
  downloadUrl: string;
  hash: string;
  certHash: string;
  createdAt: number;
}

function parseZapstoreApp(event: NostrEvent): ZapstoreApp {
  const tags = event.tags || [];
  const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
  const getAllTags = (name: string) => tags.filter(t => t[0] === name).map(t => t[1] || '');

  return {
    identifier: getTag('d'),
    name: getTag('name'),
    summary: getTag('summary'),
    description: event.content || '',
    icon: getTag('icon'),
    images: getAllTags('image'),
    license: getTag('license'),
    repository: getTag('repository'),
    url: getTag('url'),
    platform: getTag('f'),
    topics: getAllTags('t'),
    pubkey: event.pubkey,
  };
}

export class ZapstoreAppView extends View {
  private container: HTMLElement;
  private naddrRef: string;
  private systemLogger: SystemLogger;

  constructor(naddrRef: string) {
    super();
    this.naddrRef = naddrRef;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--zapstore-app';
    this.systemLogger = SystemLogger.getInstance();

    this.render();
  }

  private async render(): Promise<void> {
    this.container.innerHTML = `
      <div class="article-view-loading">
        <div class="loading-spinner"></div>
        <p>Loading app...</p>
      </div>
    `;

    try {
      const event = await this.fetchEvent();
      if (!event) {
        this.container.innerHTML = '<div class="article-view-error"><p>App not found</p></div>';
        return;
      }

      const app = parseZapstoreApp(event);
      const release = await this.fetchRelease(event);

      this.renderApp(event, app, release);
    } catch (error) {
      this.systemLogger.error('ZapstoreAppView', `Failed to load: ${error}`);
      this.container.innerHTML = '<div class="article-view-error"><p>Failed to load app</p></div>';
    }
  }

  private async fetchEvent(): Promise<NostrEvent | null> {
    const decoded = decodeNip19(this.naddrRef);
    if (decoded.type !== 'naddr') return null;

    const data = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
    const transport = NostrTransport.getInstance();
    const relays = data.relays?.length ? data.relays : [ZAPSTORE_RELAY];

    const events = await transport.fetch(relays, [{
      kinds: [data.kind],
      authors: [data.pubkey],
      '#d': [data.identifier],
      limit: 1
    }], 8000, false, 'ZapstoreApp');

    return events[0] || null;
  }

  private async fetchRelease(appEvent: NostrEvent): Promise<ReleaseInfo | null> {
    // Find release reference in app tags: ["a", "30063:pubkey:identifier@version"]
    const releaseRef = appEvent.tags.find(t => t[0] === 'a' && t[1]?.startsWith('30063:'));
    if (!releaseRef?.[1]) return null;

    const parts = releaseRef[1].split(':');
    if (parts.length < 3) return null;

    const transport = NostrTransport.getInstance();

    // Fetch release event (kind 30063)
    const releases = await transport.fetch([ZAPSTORE_RELAY], [{
      kinds: [30063 as any],
      authors: [parts[1]!],
      '#d': [parts[2]!],
      limit: 1
    }], 8000, false, 'ZapstoreRelease');

    const release = releases[0];
    if (!release) return null;

    // Fetch file metadata (kind 1063) referenced by the release
    const fileRef = release.tags.find(t => t[0] === 'e');
    let fileSize = 0;
    let versionCode = '';
    let downloadUrl = '';
    let hash = '';
    let certHash = '';

    if (fileRef?.[1]) {
      const files = await transport.fetch([ZAPSTORE_RELAY], [{
        ids: [fileRef[1]],
        limit: 1
      }], 8000, false, 'ZapstoreFile');

      const file = files[0];
      if (file) {
        const getFileTag = (name: string) => file.tags.find(t => t[0] === name)?.[1] || '';
        fileSize = parseInt(getFileTag('size')) || 0;
        versionCode = getFileTag('version_code');
        downloadUrl = getFileTag('url');
        hash = getFileTag('x');
        certHash = getFileTag('apk_signature_hash');
      }
    }

    const getRelTag = (name: string) => release.tags.find(t => t[0] === name)?.[1] || '';

    return {
      version: getRelTag('d').split('@')[1] || '',
      releaseNotes: release.content || '',
      fileSize,
      versionCode,
      downloadUrl,
      hash,
      certHash,
      createdAt: release.created_at,
    };
  }

  private async renderApp(event: NostrEvent, app: ZapstoreApp, release: ReleaseInfo | null): Promise<void> {
    const isLoggedIn = AuthService.getInstance().getCurrentUser() !== null;
    const isAndroid = PlatformService.getInstance().isAndroid;

    const naddr = encodeNaddr({
      kind: 32267,
      pubkey: app.pubkey,
      identifier: app.identifier,
      relays: [ZAPSTORE_RELAY],
    });

    // Render markdown description (breaks: false → single newlines don't create <br>)
    let descriptionHtml = '';
    if (app.description) {
      marked.setOptions({ breaks: false, gfm: true });
      const rawHtml = marked.parse(app.description) as string;
      descriptionHtml = DOMPurify.sanitize(rawHtml);
    }

    // Screenshots HTML
    const screenshotsHtml = app.images.length > 0
      ? `<div class="zapstore-app__screenshots">
          ${app.images.map(url => `<img src="${escapeHtmlAttr(url)}" alt="" class="zapstore-app__screenshot" loading="lazy" />`).join('')}
        </div>`
      : '';

    // Version badge
    const versionBadge = release?.version
      ? `<span class="badge badge--green">${escapeHtml(release.version)}</span>`
      : '';

    // "In Zapstore" button (Android only)
    const zapstoreButton = isAndroid
      ? `<a href="https://zapstore.dev/apps/${naddr}" class="btn btn--passive btn--medium zapstore-app__open-btn" target="_blank">In Zapstore</a>`
      : '';

    // App info table
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    const infoRows: string[] = [];
    if (app.identifier) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">App ID</span><span class="zapstore-app__info-value">${escapeHtml(app.identifier)}</span></div>`);
    if (app.platform) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Platform</span><span class="zapstore-app__info-value">${escapeHtml(app.platform)}</span></div>`);
    if (app.license) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">License</span><span class="zapstore-app__info-value">${escapeHtml(app.license)}</span></div>`);
    if (app.repository) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Source</span><span class="zapstore-app__info-value"><a href="${escapeHtmlAttr(app.repository)}">${escapeHtml(app.repository)}</a></span></div>`);
    if (app.url) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Website</span><span class="zapstore-app__info-value"><a href="${escapeHtmlAttr(app.url)}">${escapeHtml(app.url)}</a></span></div>`);
    if (release?.versionCode) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Version Code</span><span class="zapstore-app__info-value">${escapeHtml(release.versionCode)}</span></div>`);
    if (release?.fileSize) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Size</span><span class="zapstore-app__info-value">${(release.fileSize / 1024 / 1024).toFixed(1)} MB</span></div>`);
    if (release?.hash) infoRows.push(`<div class="zapstore-app__info-row zapstore-app__info-row--hash"><span class="zapstore-app__info-label">Hash</span><span class="zapstore-app__info-value zapstore-app__hash">${escapeHtml(release.hash)}</span><button class="copy-btn" data-copy="${escapeHtmlAttr(release.hash)}" title="Copy hash">${copyIcon}</button></div>`);
    if (release?.certHash) infoRows.push(`<div class="zapstore-app__info-row zapstore-app__info-row--hash"><span class="zapstore-app__info-label">Certificate</span><span class="zapstore-app__info-value zapstore-app__hash">${escapeHtml(release.certHash)}</span><button class="copy-btn" data-copy="${escapeHtmlAttr(release.certHash)}" title="Copy certificate hash">${copyIcon}</button></div>`);

    const releaseDate = release?.createdAt
      ? new Date(release.createdAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    if (releaseDate) infoRows.push(`<div class="zapstore-app__info-row"><span class="zapstore-app__info-label">Release Date</span><span class="zapstore-app__info-value">${releaseDate}</span></div>`);

    // Release notes
    let releaseNotesHtml = '';
    if (release?.releaseNotes) {
      marked.setOptions({ breaks: true, gfm: true });
      const rawRn = marked.parse(release.releaseNotes) as string;
      // Downgrade headings in release notes: h1→h3, h2→h4 (they sit under our h2)
      const sanitizedRn = DOMPurify.sanitize(rawRn)
        .replace(/<h2/g, '<h4').replace(/<\/h2>/g, '</h4>')
        .replace(/<h1/g, '<h3').replace(/<\/h1>/g, '</h3>');
      releaseNotesHtml = `
        <section class="zapstore-app__section">
          <h2>Latest Release</h2>
          <div class="zapstore-app__release-notes">${sanitizedRn}</div>
        </section>`;
    }

    this.container.innerHTML = `
      <div class="zapstore-app">
        <div class="zapstore-app__header">
          ${app.icon ? `<img src="${escapeHtmlAttr(app.icon)}" alt="" class="zapstore-app__icon" />` : ''}
          <div class="zapstore-app__header-info">
            <div class="zapstore-app__title-row">
              <h1 class="zapstore-app__name">${escapeHtml(app.name)}</h1>
              ${versionBadge}
            </div>
            ${app.summary ? `<p class="zapstore-app__summary">${escapeHtml(app.summary)}</p>` : ''}
            ${zapstoreButton}
          </div>
        </div>

        <div class="zapstore-app__author-mention"></div>

        ${screenshotsHtml}

        ${descriptionHtml ? `
        <section class="zapstore-app__section">
          <div class="zapstore-app__description">${descriptionHtml}</div>
        </section>` : ''}

        ${infoRows.length > 0 ? `
        <section class="zapstore-app__section">
          <h2>App Info</h2>
          <div class="zapstore-app__info-grid">
            ${infoRows.join('')}
          </div>
        </section>` : ''}

        ${releaseNotesHtml}

        <div class="zapstore-app__isl"></div>
        <div class="zapstore-app__replies"></div>
      </div>
    `;

    // Author mention
    const authorMentionContainer = this.container.querySelector('.zapstore-app__author-mention') as HTMLElement;
    if (authorMentionContainer) {
      const profileService = UserProfileService.getInstance();
      const profiles = await profileService.getUserProfiles([app.pubkey]);
      const profile = profiles.get(app.pubkey);
      const username = profile?.display_name || profile?.name || 'Unknown';
      const avatarUrl = profile?.picture || '';
      authorMentionContainer.innerHTML = `Published by ${renderUserMention(app.pubkey, { username, avatarUrl })}`;
      setupUserMentionHandlers(authorMentionContainer);
    }


    // ISL
    const islMount = this.container.querySelector('.zapstore-app__isl');
    if (islMount && event.id) {
      const addressableId = getAddressableIdentifier(event);
      const noteId = addressableId || event.id;
      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event,
        fetchStats: true,
        isLoggedIn,
        articleEventId: event.id,
      });
      islMount.appendChild(isl.getElement());
    }

    // Replies
    const repliesContainer = this.container.querySelector('.zapstore-app__replies') as HTMLElement;
    if (repliesContainer && event.id) {
      const addressableId = getAddressableIdentifier(event);
      const noteId = addressableId || event.id;
      const repliesRenderer = new RepliesRenderer({
        container: repliesContainer,
        noteId,
        noteAuthor: event.pubkey,
      });
      repliesRenderer.loadAndRender();
    }

    // Copy buttons for hash values
    this.container.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const text = (btn as HTMLElement).dataset.copy;
        if (!text) return;
        const { ClipboardActionsService } = await import('../../services/ClipboardActionsService');
        const clipboard = ClipboardActionsService.getInstance();
        const success = await clipboard.copyText(text, 'Hash', true);
        if (success) clipboard.addVisualFeedback(btn as HTMLElement);
      });
    });
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }
}
