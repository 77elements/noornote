/**
 * GitEventRenderer - Renders NIP-34 Git events as nn-cards in TV/PV/SNV.
 * Kinds: 1617 (Patch), 1618 (PR), 1621 (Issue), 1630-1633 (Status), 30617 (Repo Announcement)
 * Click opens gitworkshop.dev/<nevent|naddr> externally.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { InteractionStatusLine } from '../InteractionStatusLine';
import { encodeNevent, encodeNaddr } from '../../../services/NostrToolsAdapter';
import { escapeHtml } from '../../../helpers/escapeHtml';

interface GitEventMeta {
  label: string;
  icon: string;
  title: string;
  subtitle?: string;
}

export class GitEventRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const meta = GitEventRenderer.extractMeta(event);
    const externalUrl = GitEventRenderer.buildGitworkshopUrl(event);

    const element = document.createElement('div');
    element.className = 'note-card note-card--git';
    element.dataset.eventId = note.id;

    const noteHeader = new NoteHeader({
      pubkey: event.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: event,
      showVerification: true,
      showTimestamp: true,
      showMenu: true
    });
    element.appendChild(noteHeader.getElement());

    const card = document.createElement('div');
    card.className = 'nn-card';
    card.innerHTML = `
      <div class="nn-card__body">
        <div class="nn-card__meta">
          <span>${meta.icon}</span>
          <span>${escapeHtml(meta.label)}</span>
        </div>
        <h3 class="nn-card__title">${escapeHtml(meta.title)}</h3>
        ${meta.subtitle ? `<div class="nn-card__meta">${escapeHtml(meta.subtitle)}</div>` : ''}
        ${externalUrl ? `<button type="button" class="btn btn--passive btn--mini git-event-card__open">↗ Open on gitworkshop.dev</button>` : ''}
      </div>
    `;

    const openExternal = () => {
      if (externalUrl) window.open(externalUrl, '_blank', 'noopener,noreferrer');
    };

    card.querySelector('.git-event-card__open')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openExternal();
    });

    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      openExternal();
    });

    element.appendChild(card);

    // Skip ISL when embedded (quoted/reposted). Matches convention used by
    // createQuoteBox, ArticlePreviewRenderer, and the listing/follow-pack
    // repost branches — embedded previews don't carry their own interaction line.
    const isEmbedded = (opts.depth ?? 0) > 0;
    const noteId = GitEventRenderer.resolveIslId(event, note.id);
    if (!isEmbedded && noteId) {
      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event,
        fetchStats: opts.islFetchStats || false,
        isLoggedIn: opts.isLoggedIn || false
      });
      element.appendChild(isl.getElement());
    }

    return element;
  }

  private static extractMeta(event: { kind?: number; content?: string; tags: string[][] }): GitEventMeta {
    const kind = event.kind;
    const subjectTag = event.tags.find(t => t[0] === 'subject');
    const nameTag = event.tags.find(t => t[0] === 'name');
    const descTag = event.tags.find(t => t[0] === 'description');

    switch (kind) {
      case 1617: {
        // NIP-34: patch title is in the content's Subject: header (git format-patch),
        // not a tag. Fall back to subject tag, then "(untitled patch)".
        const title = GitEventRenderer.extractPatchSubject(event.content) || subjectTag?.[1] || '(untitled patch)';
        return { label: 'Git Patch', icon: '🩹', title };
      }
      case 1618:
        return { label: 'Pull Request', icon: '🔀', title: subjectTag?.[1] || '(untitled PR)' };
      case 1619:
        return { label: 'Pull Request Update', icon: '🔀', title: subjectTag?.[1] || '(PR update)' };
      case 1621:
        return { label: 'Git Issue', icon: '🐛', title: subjectTag?.[1] || '(untitled issue)' };
      case 1630:
        return { label: 'Status: Open', icon: '🟢', title: subjectTag?.[1] || 'Status update' };
      case 1631:
        return { label: 'Status: Applied/Merged', icon: '✅', title: subjectTag?.[1] || 'Status update' };
      case 1632:
        return { label: 'Status: Closed', icon: '⛔', title: subjectTag?.[1] || 'Status update' };
      case 1633:
        return { label: 'Status: Draft', icon: '📝', title: subjectTag?.[1] || 'Status update' };
      case 30617:
        return {
          label: 'Git Repository',
          icon: '📦',
          title: nameTag?.[1] || '(unnamed repo)',
          ...(descTag?.[1] ? { subtitle: descTag[1] } : {})
        };
      default:
        return { label: `Git Event (kind ${kind})`, icon: '📦', title: subjectTag?.[1] || '' };
    }
  }

  /**
   * Parse the Subject: header from a git format-patch payload.
   * Strips the leading "[PATCH]" / "[PATCH n/m]" prefix git inserts.
   */
  private static extractPatchSubject(content?: string): string {
    if (!content) return '';
    const match = content.match(/^Subject:\s*(.+?)(?:\r?\n|$)/m);
    if (!match || !match[1]) return '';
    return match[1].replace(/^\[PATCH(?:\s+\d+\/\d+)?\]\s*/, '').trim();
  }

  private static buildGitworkshopUrl(event: { id?: string; kind?: number; pubkey: string; tags: string[][] }): string {
    if (event.kind === 30617) {
      const dTag = event.tags.find(t => t[0] === 'd');
      if (dTag?.[1] && event.pubkey) {
        const naddr = encodeNaddr({ kind: 30617, pubkey: event.pubkey, identifier: dTag[1], relays: [] });
        return `https://gitworkshop.dev/${naddr}`;
      }
    }
    if (event.id) {
      const nevent = encodeNevent(event.id, [], event.pubkey);
      return `https://gitworkshop.dev/${nevent}`;
    }
    return '';
  }

  private static resolveIslId(event: { id?: string; kind?: number; pubkey: string; tags: string[][] }, fallback: string): string {
    if (event.kind === 30617) {
      const dTag = event.tags.find(t => t[0] === 'd');
      if (dTag?.[1]) return `30617:${event.pubkey}:${dTag[1]}`;
    }
    return event.id || fallback;
  }
}
