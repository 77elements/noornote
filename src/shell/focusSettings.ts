/**
 * Focus object settings (v2) — per-object panels for the ED-b bottom
 * drawer, opened by the gear action button on the focused object.
 *
 * Each panel COMPOSES its own small setting list from the same storage
 * helpers the classic settings use — identical storage keys, identical
 * TypedEventBus events, identical toasts — so both UIs share one state.
 * The v1 sections are monoliths (theme/language/layout mixed with feed
 * toggles) and are deliberately NOT mounted here: a panel carries only
 * what its object needs. The classic UI settings dissolve step by step
 * as objects gain panels (docs/todos/v2-focus-ui.md).
 */

import { Switch } from '../components/ui/Switch';
import { NnDropdown } from '../components/ui/NnDropdown';
import { TypedEventBus } from '../core/TypedEventBus';
import { ToastService } from '../services/ToastService';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import {
  isShowReactionsEnabled,
  setShowReactionsEnabled,
} from '../helpers/reactionsFeedSetting';
import {
  isHideSelfRepostsEnabled,
  setHideSelfRepostsEnabled,
  getSelfRepostGap,
  setSelfRepostGap,
  type SelfRepostGap,
} from '../helpers/selfRepostSetting';
import {
  isHideHighlightsEnabled,
  setHideHighlightsEnabled,
} from '../helpers/highlightSetting';
import {
  isExpiryNoticeEnabled,
  setExpiryNoticeEnabled,
} from '../helpers/nip40';
import type { FocusSettingsView } from './focusDomains';
import { _ } from '../i18n';

/**
 * Shared base: render the sections into the host element, drop everything
 * on destroy. Switches/radios bind element-scoped listeners only (they
 * die with the host); NnDropdown portals to document.body and needs an
 * explicit destroy() — panels hook that via `teardown`.
 */
abstract class FocusSettingsPanel implements FocusSettingsView {
  protected bus = TypedEventBus.getInstance();
  protected storage = PerAccountLocalStorage.getInstance();
  private host: HTMLElement | null = null;
  private teardownFns: Array<() => void> = [];

  mount(el: HTMLElement): void {
    this.host = el;
    el.innerHTML = this.render();
    this.bind(el);
  }

  destroy(): void {
    for (const fn of this.teardownFns) fn();
    this.teardownFns = [];
    if (this.host) this.host.innerHTML = '';
    this.host = null;
  }

  protected teardown(fn: () => void): void {
    this.teardownFns.push(fn);
  }

  protected abstract render(): string;
  protected abstract bind(el: HTMLElement): void;

  /** v1-parity switch mount: render into the control container. */
  protected mountSwitch(
    container: Element | null,
    checked: boolean,
    onChange: (checked: boolean) => void
  ): void {
    if (!container) return;
    const sw = new Switch({ label: '', checked, onChange });
    container.innerHTML = sw.render();
    sw.setupEventListeners(container as HTMLElement);
  }
}

/**
 * Social Media (Timeline) object settings — the feed-shaping toggles the
 * classic UI settings carried among global options. Every change applies
 * instantly to the open timeline via the same EventBus events v1 emits.
 */
export class FocusSocialSettings extends FocusSettingsPanel {
  protected render(): string {
    const gapOptions: Array<[SelfRepostGap, string]> = [
      ['3d', _('3 days')],
      ['1w', _('1 week')],
      ['3mo', _('3 months')],
      ['1y', _('1 year')],
      ['all', _('All self-reposts (any age)')],
    ];
    const hideSelfReposts = isHideSelfRepostsEnabled();
    return `
      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Hide self-reposts')}</span>
          <div class="setting__control" data-focus-setting="hide-self-reposts"></div>
          <p class="setting__desc">
            ${_("When enabled, reposts of a user's own notes are hidden from your timeline. Reposts of other people's notes are unaffected.")}
          </p>
          <div class="self-repost-gap${hideSelfReposts ? '' : ' is-hidden'}" data-focus-setting="self-repost-gap">
            <span class="setting__label">${_('Disable self-reposts younger than:')}</span>
            ${gapOptions
              .map(
                ([value, label]) => `
              <label class="nn-checkbox nn-checkbox--label-left">
                <span class="setting__label">${label}</span>
                <input type="radio" name="focus-self-repost-gap" value="${value}" ${getSelfRepostGap() === value ? 'checked' : ''} />
              </label>
            `
              )
              .join('')}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Show reactions')}</span>
          <div class="setting__control" data-focus-setting="show-reactions"></div>
          <p class="setting__desc">
            ${_('Show the reactions (likes) of people you follow as entries in your timeline. Off by default. Individual users can be enabled from their profile.')}
          </p>
        </div>
      </section>

      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Hide highlights')}</span>
          <div class="setting__control" data-focus-setting="hide-highlights"></div>
          <p class="setting__desc">
            ${_('When enabled, highlight posts by others that quote an external website (kind 9802 with a web source) are hidden from your timelines, including pure reposts of them. Your own highlights stay visible. Individual users can be hidden from their profile.')}
          </p>
        </div>
      </section>

      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Show expiry notice')}</span>
          <div class="setting__control" data-focus-setting="expiry-notice"></div>
          <p class="setting__desc">
            ${_('Show a small "Post expires on …" line under notes that carry an expiration time (NIP-40). Off by default.')}
          </p>
        </div>
      </section>

      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Disable post truncation')}</span>
          <div class="setting__control" data-focus-setting="post-truncation"></div>
          <p class="setting__desc">
            ${_('When enabled, long posts will always be displayed in full without "Show More" buttons.')}
          </p>
        </div>
      </section>

      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Memory optimization (experimental)')}</span>
          <div class="setting__control" data-focus-setting="content-visibility"></div>
          <p class="setting__desc">
            ${_('Skips rendering of off-screen notes (CSS <code>content-visibility: auto</code>). Significantly reduces memory usage on long timelines, especially on Linux. May cause minor scrollbar jumps when scrolling fast, disable if it bothers you.')}
          </p>
        </div>
      </section>
    `;
  }

  protected bind(el: HTMLElement): void {
    // Hide self-reposts + age gap (gap applies only while hidden).
    this.mountSwitch(
      el.querySelector('[data-focus-setting="hide-self-reposts"]'),
      isHideSelfRepostsEnabled(),
      checked => {
        setHideSelfRepostsEnabled(checked);
        this.bus.emit('settings:hide-self-reposts-changed', {
          hidden: checked,
        });
        ToastService.show(
          checked
            ? _('Self-reposts hidden from timeline')
            : _('Self-reposts shown again'),
          'success'
        );
        el.querySelector(
          '[data-focus-setting="self-repost-gap"]'
        )?.classList.toggle('is-hidden', !checked);
      }
    );
    const gapLabels: Record<SelfRepostGap, string> = {
      '3d': _('3 days'),
      '1w': _('1 week'),
      '3mo': _('3 months'),
      '1y': _('1 year'),
      all: _('all'),
    };
    el.querySelectorAll('input[name="focus-self-repost-gap"]').forEach(
      radio => {
        radio.addEventListener('change', () => {
          const value = (radio as HTMLInputElement).value as SelfRepostGap;
          setSelfRepostGap(value);
          this.bus.emit('settings:hide-self-reposts-changed', {
            hidden: true,
          });
          ToastService.show(
            value === 'all'
              ? _('Hiding all self-reposts')
              : _('Hiding self-reposts younger than %s', gapLabels[value]),
            'success'
          );
        });
      }
    );

    // Show reactions (feed entries for followed users).
    this.mountSwitch(
      el.querySelector('[data-focus-setting="show-reactions"]'),
      isShowReactionsEnabled(),
      checked => {
        setShowReactionsEnabled(checked);
        this.bus.emit('settings:show-reactions-changed', { shown: checked });
        ToastService.show(
          checked
            ? _('Reactions from people you follow now appear in your timeline')
            : _('Reactions hidden from your timeline again'),
          'success'
        );
      }
    );

    // Hide others' web-source highlights.
    this.mountSwitch(
      el.querySelector('[data-focus-setting="hide-highlights"]'),
      isHideHighlightsEnabled(),
      checked => {
        setHideHighlightsEnabled(checked);
        this.bus.emit('settings:hide-highlights-changed', { hidden: checked });
        ToastService.show(
          checked
            ? _("Others' highlights hidden")
            : _('Highlights shown again'),
          'success'
        );
      }
    );

    // Expiry notices (NIP-40 line under expiring notes) — rendering-time
    // option, no live event in v1 either.
    this.mountSwitch(
      el.querySelector('[data-focus-setting="expiry-notice"]'),
      isExpiryNoticeEnabled(),
      checked => {
        setExpiryNoticeEnabled(checked);
        ToastService.show(
          checked ? _('Expiry notices shown') : _('Expiry notices hidden'),
          'success'
        );
      }
    );

    // Disable post truncation (long posts always in full).
    this.mountSwitch(
      el.querySelector('[data-focus-setting="post-truncation"]'),
      this.storage.get<boolean>(StorageKeys.DISABLE_POST_TRUNCATION, false),
      checked => {
        this.storage.set(StorageKeys.DISABLE_POST_TRUNCATION, checked);
        this.bus.emit('settings:post-truncation-changed', {
          disabled: checked,
        });
        ToastService.show(
          checked
            ? _('Post truncation disabled - all posts will be shown in full')
            : _('Post truncation enabled'),
          'success'
        );
      }
    );

    // Memory optimization: content-visibility on off-screen note cards.
    this.mountSwitch(
      el.querySelector('[data-focus-setting="content-visibility"]'),
      this.storage.get<boolean>(StorageKeys.CONTENT_VISIBILITY_AUTO, false),
      checked => {
        this.storage.set(StorageKeys.CONTENT_VISIBILITY_AUTO, checked);
        document.documentElement.classList.toggle(
          'content-visibility-auto',
          checked
        );
        ToastService.show(
          checked
            ? _('Memory optimization enabled')
            : _('Memory optimization disabled'),
          'success'
        );
      }
    );
  }
}

/**
 * Articles object settings — the article feed source degree. Grows as
 * more article-specific settings move out of the classic UI settings.
 */
export class FocusArticlesSettings extends FocusSettingsPanel {
  protected render(): string {
    return `
      <section class="section">
        <div class="setting">
          <span class="setting__label">${_('Article feed source, main view')}</span>
          <div class="setting__control" data-focus-setting="article-foaf"></div>
          <p class="setting__desc">
            ${_('Whose articles appear in <strong>/articles</strong>. Higher degrees broaden the feed beyond your direct follows but take longer to build and include authors you may not know.')}
          </p>
        </div>
      </section>
    `;
  }

  protected bind(el: HTMLElement): void {
    const container = el.querySelector('[data-focus-setting="article-foaf"]');
    if (!container) return;
    const options = [
      { value: '1', label: _('Degree 1, Direct follows') },
      { value: '2', label: _('Degree 2, Friends of friends') },
      {
        value: '3',
        label: _('Degree 3, Friends of friends of friends (slow to build)'),
      },
    ];
    const labels: Record<string, string> = {
      '1': _('Degree 1 (direct follows)'),
      '2': _('Degree 2 (friends of friends)'),
      '3': _('Degree 3 (friends of friends of friends)'),
    };
    const dropdown = new NnDropdown({
      options,
      selectedValue: String(
        this.storage.get<number>(StorageKeys.ARTICLE_FEED_FOAF_DEGREE_MAIN, 1)
      ),
      onChange: value => {
        const degree = Number(value);
        this.storage.set(StorageKeys.ARTICLE_FEED_FOAF_DEGREE_MAIN, degree);
        this.bus.emit('settings:article-foaf-degree-changed', {
          variant: 'main',
          degree,
        });
        ToastService.show(
          _('Main article feed: %s', labels[value] ?? value),
          'success'
        );
      },
      className: 'article-foaf-dropdown',
    });
    container.appendChild(dropdown.getElement());
    // NnDropdown portals its menu to document.body and binds document/
    // window listeners — it must be destroyed explicitly.
    this.teardown(() => dropdown.destroy());
  }
}

/** Registry factories wired on the FocusDomainDefs. */
export const socialSettings = (): FocusSettingsView =>
  new FocusSocialSettings();
export const articlesSettings = (): FocusSettingsView =>
  new FocusArticlesSettings();
