/**
 * Insert-Link modal — used by Heading + Text blocks (and future text-flow
 * blocks) to wrap a selection in `<a href="…">…</a>`. Pure UI helper:
 * captures the four pieces (URL, link text, optional title, target) and
 * resolves with the values, or null when the user cancels.
 *
 * The caller is responsible for splicing the resulting HTML back into
 * the block's content at the saved selection range — the modal itself
 * doesn't touch any block state.
 */

import { ModalService } from '../../../services/ModalService';
import { CustomDropdown } from '../../../components/ui/CustomDropdown';
import { escapeHtmlAttr } from '../../../helpers/escapeHtml';

export interface InsertLinkValues {
  url: string;
  text: string;
  /** Optional `title="…"` tooltip. */
  title?: string;
  /** Anchor target (`_blank` for new tab, undefined for default). */
  target?: '_blank';
}

const TARGET_OPTIONS = [
  { value: '',       label: 'None (same tab)' },
  { value: '_blank', label: 'New tab' },
];

export function openInsertLinkModal(initialText: string): Promise<InsertLinkValues | null> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'nospress-link-modal';
    root.innerHTML = `
      <div class="form__row">
        <label>URL</label>
        <input type="url" class="input" data-link-field="url" placeholder="https://…" />
      </div>
      <div class="form__row">
        <label>Text to display</label>
        <input type="text" class="input" data-link-field="text" value="${escapeHtmlAttr(initialText)}" />
      </div>
      <div class="form__row">
        <label>Title (tooltip, optional)</label>
        <input type="text" class="input" data-link-field="title" />
      </div>
      <div class="form__row">
        <label>Target</label>
        <div class="nospress-link-modal__target-mount" data-target-mount></div>
      </div>
      <div class="l-row--end-pair">
        <button type="button" class="btn btn--passive" data-link-cancel>Cancel</button>
        <button type="button" class="btn" data-link-ok>OK</button>
      </div>
    `;

    const targetDropdown = new CustomDropdown({
      options: TARGET_OPTIONS,
      selectedValue: '',
      onChange: () => { /* read on submit */ },
    });
    root.querySelector('[data-target-mount]')!.appendChild(targetDropdown.getElement());

    let resolved = false;
    const cleanupAndResolve = (value: InsertLinkValues | null) => {
      if (resolved) return;
      resolved = true;
      targetDropdown.destroy();
      ModalService.getInstance().hide();
      resolve(value);
    };

    const submit = () => {
      const url = root.querySelector<HTMLInputElement>('[data-link-field="url"]')!.value.trim();
      if (!url) {
        // Bare-minimum validation — focus URL and bail without resolving.
        root.querySelector<HTMLInputElement>('[data-link-field="url"]')!.focus();
        return;
      }
      const text = root.querySelector<HTMLInputElement>('[data-link-field="text"]')!.value;
      const title = root.querySelector<HTMLInputElement>('[data-link-field="title"]')!.value.trim();
      const target = targetDropdown.getValue().trim();
      const values: InsertLinkValues = { url, text };
      if (title) values.title = title;
      if (target === '_blank') values.target = '_blank';
      cleanupAndResolve(values);
    };

    root.querySelector('[data-link-ok]')!.addEventListener('click', submit);
    root.querySelector('[data-link-cancel]')!.addEventListener('click', () => cleanupAndResolve(null));
    // Enter on any input (except the cancel button) submits.
    root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault();
        submit();
      }
    });

    ModalService.getInstance().show({
      title: 'Insert link',
      content: root,
      width: '500px',
      height: 'auto',
      onClose: () => cleanupAndResolve(null),
    });

    // Focus URL after the modal mounts.
    setTimeout(() => root.querySelector<HTMLInputElement>('[data-link-field="url"]')?.focus(), 50);
  });
}

/**
 * Compose the `<a …>` HTML payload from the modal's resolved values.
 * Falls back to the URL as link text if the user cleared the text
 * field. Adds `rel="noopener noreferrer"` automatically when target is
 * `_blank` (security hygiene; matches the rest of the codebase).
 */
export function buildLinkHtml(values: InsertLinkValues): string {
  const url = escapeHtmlAttr(values.url);
  const text = values.text || values.url;
  const titleAttr = values.title ? ` title="${escapeHtmlAttr(values.title)}"` : '';
  const targetAttr = values.target === '_blank'
    ? ` target="_blank" rel="noopener noreferrer"`
    : '';
  return `<a href="${url}"${titleAttr}${targetAttr}>${text}</a>`;
}
