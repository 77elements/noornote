import { View } from '../../components/views/View';
import { BadgeService, type OwnBadgeDefinition } from './BadgeService';
import { isBadgesEnabled, setBadgesEnabled } from './index';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export class BadgesView extends View {
  private container: HTMLElement;
  private badgeService: BadgeService | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-badges';
    this.render();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private render(): void {
    const enabled = isBadgesEnabled();

    this.container.innerHTML = `
      <h1>Badges</h1>
      <section class="section" data-role="toggle-section"></section>
      ${enabled ? `
      <section class="section">
        <h2>Create Badge</h2>
        <div class="form__row">
          <label>Slug (unique identifier)</label>
          <input class="input" type="text" data-field="slug" placeholder="e.g. early-supporter" />
        </div>
        <div class="form__row">
          <label>Name</label>
          <input class="input" type="text" data-field="name" placeholder="e.g. Early Supporter" />
        </div>
        <div class="form__row">
          <label>Description</label>
          <textarea class="textarea textarea--small" data-field="description" placeholder="What this badge represents…"></textarea>
        </div>
        <div class="form__row">
          <label>Image URL</label>
          <input class="input" type="text" data-field="imageUrl" placeholder="https://…/badge.png" />
        </div>
        <div class="l-row--split">
          <div>
            <button type="button" class="btn btn--passive" data-action="upload-image">Upload image…</button>
            <input type="file" accept="image/*" style="display:none" data-role="file-input" />
            <span data-role="upload-status"></span>
          </div>
          <button class="btn" data-action="create-badge">Save to Badge Gallery</button>
        </div>
      </section>
      <section class="section">
        <h2>Your Badge Gallery</h2>
        <div data-role="gallery" class="pulsate">Loading…</div>
      </section>
      ` : ''}
    `;

    const toggleSection = this.container.querySelector('[data-role="toggle-section"]')!;
    const sw = new Switch({
      label: 'Enable Badges',
      checked: enabled,
      onChange: (checked) => {
        setBadgesEnabled(checked);
        EventBus.getInstance().emit('badges:addon-toggle', checked);
        this.render();
      },
    });
    toggleSection.innerHTML = sw.render();
    sw.setupEventListeners(toggleSection as HTMLElement);

    if (enabled) {
      this.setupCreateForm();
      this.loadGallery();
    }
  }

  private setupCreateForm(): void {
    const uploadBtn = this.container.querySelector('[data-action="upload-image"]');
    const fileInput = this.container.querySelector('[data-role="file-input"]') as HTMLInputElement | null;
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        ToastService.show('Please select an image file', 'error');
        return;
      }
      const status = this.container.querySelector('[data-role="upload-status"]') as HTMLElement | null;
      if (status) { status.textContent = 'Uploading…'; status.classList.add('pulsate'); }
      try {
        const { ModuleLoader } = await import('../../core/ModuleLoader');
        type MediaApi = import('../../modules/media/contracts').MediaModuleApi;
        const mediaApi = await ModuleLoader.getInstance().ensure<MediaApi>('media');
        if (!mediaApi) { ToastService.show('Media module not available', 'error'); return; }
        const result = await mediaApi.uploadFile(file);
        if (result.success && result.url) {
          const urlInput = this.container.querySelector('[data-field="imageUrl"]') as HTMLInputElement | null;
          if (urlInput) urlInput.value = result.url;
          ToastService.show('Image uploaded', 'success');
        } else {
          ToastService.show(result.error || 'Upload failed', 'error');
        }
      } catch (err) {
        ToastService.show((err as Error).message || 'Upload failed', 'error');
      } finally {
        if (status) { status.textContent = ''; status.classList.remove('pulsate'); }
      }
    });

    const btn = this.container.querySelector('[data-action="create-badge"]');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const slug = (this.container.querySelector('[data-field="slug"]') as HTMLInputElement)?.value.trim();
      const name = (this.container.querySelector('[data-field="name"]') as HTMLInputElement)?.value.trim();
      const description = (this.container.querySelector('[data-field="description"]') as HTMLTextAreaElement)?.value.trim();
      const imageUrl = (this.container.querySelector('[data-field="imageUrl"]') as HTMLInputElement)?.value.trim();

      if (!slug || !name) {
        ToastService.show('Slug and Name are required', 'error');
        return;
      }

      if (!this.badgeService) {
        const { BadgeService } = await import('./BadgeService');
        this.badgeService = BadgeService.getInstance();
      }

      const success = await this.badgeService.createBadgeDefinition({
        slug,
        name,
        description: description || undefined,
        imageUrl: imageUrl || undefined,
      });

      if (success) {
        const slugInput = this.container.querySelector('[data-field="slug"]') as HTMLInputElement;
        slugInput.value = '';
        slugInput.disabled = false;
        (this.container.querySelector('[data-field="name"]') as HTMLInputElement).value = '';
        (this.container.querySelector('[data-field="description"]') as HTMLTextAreaElement).value = '';
        (this.container.querySelector('[data-field="imageUrl"]') as HTMLInputElement).value = '';
        this.loadGallery();
      }
    });
  }

  private async loadGallery(): Promise<void> {
    const galleryEl = this.container.querySelector('[data-role="gallery"]');
    if (!galleryEl) return;

    if (!this.badgeService) {
      const { BadgeService } = await import('./BadgeService');
      this.badgeService = BadgeService.getInstance();
    }

    const defs = await this.badgeService.fetchOwnDefinitions();
    if (defs.length === 0) {
      galleryEl.innerHTML = '<p style="color: var(--color-3)">No badges created yet.</p>';
      galleryEl.classList.remove('pulsate');
      return;
    }

    galleryEl.innerHTML = defs.map(d => BadgesView.renderBadgeCard(d)).join('');
    galleryEl.classList.remove('pulsate');

    this.setupGalleryActions(galleryEl as HTMLElement, defs);
    this.loadAwardeesForGallery(galleryEl as HTMLElement, defs);
  }

  private setupGalleryActions(galleryEl: HTMLElement, defs: OwnBadgeDefinition[]): void {
    galleryEl.querySelectorAll('[data-action="edit-badge"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const slug = (btn as HTMLElement).dataset.slug;
        if (!slug) return;
        const def = defs.find(d => d.slug === slug);
        if (!def) return;
        this.fillFormForEdit(def);
      });
    });

    galleryEl.querySelectorAll('[data-action="delete-badge"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const slug = (btn as HTMLElement).dataset.slug;
        if (!slug) return;
        const user = (await import('../../services/AuthService')).AuthService.getInstance().getCurrentUser();
        if (!user) return;
        const coordinate = `30009:${user.pubkey}:${slug}`;
        const { DeletionService } = await import('../../services/DeletionService');
        const success = await DeletionService.getInstance().deleteByCoordinates([coordinate]);
        if (success) {
          ToastService.show('Badge deleted', 'success');
          this.loadGallery();
        }
      });
    });
  }

  private async loadAwardeesForGallery(galleryEl: HTMLElement, defs: OwnBadgeDefinition[]): Promise<void> {
    const { UserProfileService } = await import('../../services/UserProfileService');
    const profileService = UserProfileService.getInstance();
    const user = (await import('../../services/AuthService')).AuthService.getInstance().getCurrentUser();
    if (!user || !this.badgeService) return;

    for (const def of defs) {
      const coordinate = `30009:${user.pubkey}:${def.slug}`;
      const awards = await this.badgeService.fetchAwardsForBadge(coordinate);

      const awardeesMount = galleryEl.querySelector(`[data-awardees-slug="${def.slug}"]`);
      if (!awardeesMount) continue;

      if (awards.length === 0) {
        awardeesMount.innerHTML = '<span style="color:var(--color-3)">No recipients yet</span>';
        continue;
      }

      const entries: string[] = [];
      for (const award of awards) {
        const pTags = award.tags.filter(t => t[0] === 'p' && t[1]);
        for (const pTag of pTags) {
          const pk = pTag[1]!;
          const name = profileService.getDisplayName(pk);
          const awardId = award.id ?? '';
          entries.push(
            `<span>${escapeHtml(name)} <a href="#" class="badge-revoke-link" data-award-id="${escapeHtmlAttr(awardId)}">Revoke</a></span>`
          );
        }
      }
      awardeesMount.innerHTML = entries.join('<br>');

      awardeesMount.querySelectorAll('.badge-revoke-link').forEach(link => {
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const awardId = (link as HTMLElement).dataset.awardId;
          if (!awardId) return;
          const success = await this.badgeService!.revokeAward(awardId);
          if (success) {
            const entry = (link as HTMLElement).closest('span');
            if (entry) entry.remove();
          }
        });
      });
    }
  }

  private fillFormForEdit(def: OwnBadgeDefinition): void {
    const slugInput = this.container.querySelector('[data-field="slug"]') as HTMLInputElement | null;
    const nameInput = this.container.querySelector('[data-field="name"]') as HTMLInputElement | null;
    const descInput = this.container.querySelector('[data-field="description"]') as HTMLTextAreaElement | null;
    const imageInput = this.container.querySelector('[data-field="imageUrl"]') as HTMLInputElement | null;

    if (slugInput) { slugInput.value = def.slug; slugInput.disabled = true; }
    if (nameInput) nameInput.value = def.name;
    if (descInput) descInput.value = def.description;
    if (imageInput) imageInput.value = def.imageUrl ?? '';

    this.container.querySelector('h2')!.scrollIntoView({ behavior: 'smooth' });
  }

  private static renderBadgeCard(def: OwnBadgeDefinition): string {
    const img = def.imageUrl
      ? `<img src="${escapeHtmlAttr(def.imageUrl)}" alt="${escapeHtmlAttr(def.name)}" loading="lazy" />`
      : '🏅';
    const imgClass = def.imageUrl ? '' : ' badge-award__thumb--emoji';

    return `<div class="badge-award">
      <div class="badge-award__thumb${imgClass}">${img}</div>
      <div class="badge-award__info">
        <div class="badge-award__name">${escapeHtml(def.name)}</div>
        ${def.description ? `<div class="badge-award__desc">${escapeHtml(def.description)}</div>` : ''}
        <div class="badge-award__awardees">slug: ${escapeHtml(def.slug)}</div>
        <div class="badge-award__recipients" data-awardees-slug="${escapeHtmlAttr(def.slug)}"><span class="pulsate">Loading…</span></div>
      </div>
      <div>
        <button class="btn btn--mini btn--passive" data-action="edit-badge" data-slug="${escapeHtmlAttr(def.slug)}">Edit</button>
        <button class="btn btn--mini btn--danger" data-action="delete-badge" data-slug="${escapeHtmlAttr(def.slug)}">Delete</button>
      </div>
    </div>`;
  }
}
