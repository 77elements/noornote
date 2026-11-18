/**
 * Load HUD (v2) — the typed-trigger proof widget ("loadmon" on any
 * non-input surface): a small terminal-style panel, bottom right, that
 * shows LIVE what the load promise delivers — relay/addon/hidden counts
 * plus a human-readable event feed narrated by diffing the live state
 * every second: "Live Streams object unloaded · 23 KB of code unloaded
 * · Relay activity stopped". Code sizes are real build-measured numbers
 * (scripts/addon-code-sizes.ts → src/generated/addonCodeSizes.ts), not
 * estimates. Built for DEMO: hand the machine to someone, hide an
 * object, the widget narrates the shutdown as it happens. Nothing here
 * is dev-gated — the whole point is proving it to non-developers — but
 * it is strictly opt-in (typed trigger, session only, no persistence,
 * no menu entry, no i18n).
 *
 * Mounts on <body> (portalled out of the shell DOM) so it survives focus
 * navigation, object opens and hide/unhide re-renders. Self-contained
 * 1 s poll; destroy contract clears the interval + detaches.
 */

import { NostrTransport } from '../services/transport/NostrTransport';
import { AddonLoader } from '../addons/AddonLoader';
import { ADDON_RUNTIME_CODE_BYTES } from '../generated/addonCodeSizes';
import { loadHiddenObjectIds } from './hiddenObjectsStore';
import { HIDDEN_ADDON_DOMAINS } from './hiddenAddonDomains';
import { FOCUS_DOMAINS } from './focusDomains';

/** Newest-first event blocks, capped (each block = 1..n lines). */
const MAX_EVENTS = 8;

/**
 * Known fixed live-subscription ids → the v2 object that owns them.
 * Any id NOT in this table cannot come from the v2 shell's object
 * machinery (these six are all of it) — it is classic (v1-path) code
 * and gets its raw id + "(v1)" so a v1 remnant can never hide behind
 * a friendly label. Interaction-subs from classic view code (e.g.
 * live-stats-<noteId> while a note is open) land in that bucket too —
 * legit when view-driven, but visibly sourced.
 */
const SUB_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  'dm-subscription': 'DMs (v2)',
  'notifications-ptag': 'Notifications (v2)',
  'notifications-etag': 'Notifications (v2)',
  'nostr-majlis-dhikr-rounds': 'Nostr Majlis (v2)',
  'nostr-majlis-dhikr-commits': 'Nostr Majlis (v2)',
  'nostr-majlis-dhikr-moderation': 'Nostr Majlis (v2)',
});

/**
 * "Notifications (v2) ×2, DMs (v2)" — grouped owners of the live subs.
 * Unknown ids show as their raw (truncated) id + "(v1)" so nothing is
 * invisible and the v1-still-legit claim stays checkable at a glance.
 */
function subsBy(subs: string[]): string {
  const counts = new Map<string, number>();
  for (const id of subs) {
    const known = SUB_OWNERS[id];
    const label =
      known ?? `${id.length > 20 ? `${id.slice(0, 19)}…` : id} (v1)`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([label, n]) =>
    n > 1 ? `${label} ×${n}` : label
  );
  const joined = parts.join(', ');
  return joined.length > 110 ? `${joined.slice(0, 109)}…` : joined;
}

let hudEl: HTMLElement | null = null;
let pollTimer: number | null = null;
let events: string[][] = [];
let lastSubs: Set<string> | null = null;
let lastAddons: Set<string> | null = null;
let lastHidden: Set<string> | null = null;
/** Last rendered rows HTML — identical output is not re-written, so a
 * text selection the user is making inside the HUD survives the 1 s poll. */
let lastRowsHtml: string | null = null;
/** Baseline counts at HUD-open — the "saved" row shows the live delta. */
let baselineSubs = 0;
let baselineAddons: Set<string> = new Set();

/**
 * Human format for a build-measured code size; null when the addon has
 * no measured size (then the HUD simply omits the number — it never
 * invents one).
 */
function fmtKb(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return '<1 KB';
  return `${Math.round(bytes / 1024)} KB`;
}

function domainLabel(id: string): string {
  return FOCUS_DOMAINS.find(d => d.id === id)?.label ?? id;
}

/** Focus-domain label for an addon registry id (fallback: humanized id). */
function addonLabel(addonId: string): string {
  for (const [domainId, mapped] of Object.entries(HIDDEN_ADDON_DOMAINS)) {
    if (mapped === addonId) return domainLabel(domainId);
  }
  return addonId
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pushEvent(lines: string[]): void {
  events.unshift(lines);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

/**
 * Diff the fresh snapshot against the last one and narrate the deltas
 * as demo-readable event blocks. First call only sets the baseline —
 * the widget never invents events for state that predates opening it.
 */
function collectEvents(
  subs: Set<string>,
  addons: Set<string>,
  hidden: Set<string>
): void {
  const first = lastHidden === null;
  const prevHidden = lastHidden ?? new Set<string>();
  const prevAddons = lastAddons ?? new Set<string>();
  const prevSubCount = lastSubs === null ? subs.size : lastSubs.size;
  lastHidden = hidden;
  lastAddons = addons;
  lastSubs = subs;
  if (first) {
    baselineSubs = subs.size;
    baselineAddons = addons;
    return;
  }

  let subsDropped = subs.size < prevSubCount;
  for (const id of hidden) {
    if (!prevHidden.has(id)) pushEvent([`${domainLabel(id)} hidden`]);
  }
  for (const id of prevHidden) {
    if (!hidden.has(id)) pushEvent([`${domainLabel(id)} unhidden`]);
  }
  for (const addonId of prevAddons) {
    if (addons.has(addonId)) continue;
    const kb = fmtKb(ADDON_RUNTIME_CODE_BYTES[addonId]);
    const lines = [
      `${addonLabel(addonId)} object unloaded`,
      ...(kb ? [`${kb} of code unloaded`] : []),
    ];
    if (subsDropped) {
      lines.push('Relay activity stopped');
      subsDropped = false;
    }
    pushEvent(lines);
  }
  let subsAdded = subs.size > prevSubCount;
  for (const addonId of addons) {
    if (prevAddons.has(addonId)) continue;
    subsAdded = false; // the load block already narrates the resume
    const kb = fmtKb(ADDON_RUNTIME_CODE_BYTES[addonId]);
    pushEvent([
      `${addonLabel(addonId)} object loaded`,
      ...(kb ? [`${kb} of code loaded`] : []),
      'Relay activity resumed',
    ]);
  }
  // Subscriptions closed without an addon unload (e.g. a hidden
  // list-backed domain or the messages/notifications services shed
  // their live subs): still worth narrating.
  if (subsDropped) pushEvent(['Relay activity stopped']);
  // Subscriptions opened without an addon load (e.g. an unhidden
  // messages/notifications service fresh-starts its live subs).
  if (subsAdded) pushEvent(['Relay activity resumed']);
}

function render(): void {
  const rows = hudEl?.querySelector('[data-load-hud-rows]');
  if (!rows) return;
  const subs = NostrTransport.getInstance().getLiveSubscriptionSnapshot();
  const addons = AddonLoader.getInstance()
    .listLoadState()
    .filter(a => a.loaded)
    .map(a => a.id);
  const hidden = loadHiddenObjectIds();
  const addonSet = new Set(addons);
  collectEvents(new Set(subs.map(s => s.subId)), addonSet, new Set(hidden));
  const evHtml =
    events
      .map(
        block =>
          `<div class="load-hud__ev">${block
            .map(l => `<div class="load-hud__ev-line">${esc(l)}</div>`)
            .join('')}</div>`
      )
      .join('') ||
    '<div class="load-hud__ev"><div class="load-hud__ev-line">watching — hide an object</div></div>';
  // The "saved" row: live delta vs the baseline captured at HUD-open —
  // exactly "how much do I save right now" for the demo. KB only for
  // addon runtimes (service domains shed subs, not code), from the
  // build-measured per-addon sizes; unknown addons contribute nothing.
  let savedCodeBytes = 0;
  for (const addonId of baselineAddons) {
    if (!addonSet.has(addonId))
      savedCodeBytes += ADDON_RUNTIME_CODE_BYTES[addonId] ?? 0;
  }
  for (const addonId of addonSet) {
    if (!baselineAddons.has(addonId))
      savedCodeBytes -= ADDON_RUNTIME_CODE_BYTES[addonId] ?? 0;
  }
  const savedKbText = fmtKb(savedCodeBytes);
  const savedSubs = baselineSubs - subs.length;
  const savedParts: string[] = [];
  if (savedKbText) savedParts.push(savedKbText);
  if (savedSubs !== 0)
    savedParts.push(`${savedSubs} sub${savedSubs === 1 ? '' : 's'}`);
  const savedRow =
    savedParts.length > 0
      ? `<div class="load-hud__row load-hud__row--head">saved ${esc(savedParts.join(' · '))}</div>`
      : '';
  const byText = subsBy(subs.map(s => s.subId));
  const loadedCode = addons.reduce(
    (sum, id) => sum + (ADDON_RUNTIME_CODE_BYTES[id] ?? 0),
    0
  );
  const codeText = fmtKb(loadedCode);
  const html = `
    <div class="load-hud__row load-hud__row--head">relay subs ${subs.length}</div>
    ${byText ? `<div class="load-hud__row load-hud__row--sub">by: ${esc(byText)}</div>` : ''}
    <div class="load-hud__row load-hud__row--head">addons ${addons.length}</div>
    ${codeText ? `<div class="load-hud__row load-hud__row--sub">code loaded ${esc(codeText)}</div>` : ''}
    <div class="load-hud__row load-hud__row--head">hidden ${hidden.length}</div>
    ${savedRow}
    <div class="load-hud__row load-hud__row--head">events</div>
    ${evHtml}
  `;
  // Skip the DOM write when nothing changed — re-writing innerHTML
  // every second would destroy any text selection the user is making.
  if (html !== lastRowsHtml) {
    rows.innerHTML = html;
    lastRowsHtml = html;
  }
}

function tick(): void {
  try {
    render();
  } catch {
    /* a torn-down service mid-poll — next tick retries */
  }
}

/** Open (or refresh) the HUD. Idempotent — the trigger word re-opens it. */
export function openLoadHud(): void {
  if (hudEl) {
    tick();
    return;
  }
  events = [];
  lastSubs = null;
  lastAddons = null;
  lastHidden = null;
  lastRowsHtml = null;
  hudEl = document.createElement('div');
  hudEl.className = 'load-hud';
  hudEl.dataset.loadHud = '';
  hudEl.innerHTML = `
    <button type="button" class="load-hud__title" data-load-hud-close>load monitor ×</button>
    <div class="load-hud__rows" data-load-hud-rows></div>
  `;
  hudEl
    .querySelector('[data-load-hud-close]')
    ?.addEventListener('click', closeLoadHud);
  document.body.appendChild(hudEl);
  render();
  pollTimer = window.setInterval(tick, 1000);
}

/** Destroy contract: interval cleared, element detached, state dropped. */
export function closeLoadHud(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  hudEl?.remove();
  hudEl = null;
  events = [];
  lastSubs = null;
  lastAddons = null;
  lastHidden = null;
  lastRowsHtml = null;
}
