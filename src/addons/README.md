# Addons Architecture

## Goal

**ON = code loaded and running. OFF = code not parsed, not in RAM, app stays lean.**

## AddonLoader (`AddonLoader.ts`)

Single source of truth for the lifecycle of every addon. Singleton.

- Registers addons from `registerAddons.ts` with a `load:` factory that is a dynamic `import()` of the addon's `runtime.ts`.
- Listens to `user:login` (with pubkey), `user:logout`, and per-addon `<id>:addon-toggle` events.
- On `user:login`: iterates registered addons; for each enabled addon, loads the runtime and calls `runtime.init(ctx)`. For account switches it destroys the previous instance first.
- On `user:logout`: destroys every loaded runtime.
- On toggle events: activates/deactivates the single addon.
- Serializes init/destroy per addon through a promise chain — no overlapping lifecycle, no race on toggle spam.
- Idempotent: double init is a no-op; double destroy is a no-op.
- Logs every lifecycle event to the `addons` DiagLog area (parsed by `diagnose/addons_lifecycle.py`).

## Per-addon runtime (`<id>/runtime.ts`)

Every addon that wants to participate in true lazy-loading has a `runtime.ts` exporting `default` implementing `AddonRuntime { init(ctx): Promise<void>; destroy(): Promise<void> }`.

**Rule:** Heavy modules are statically imported ONLY inside `runtime.ts`. Rollup splits `runtime.ts` (and anything it transitively imports statically) into a separate chunk that is fetched only when the runtime is loaded.

```ts
// src/addons/<id>/runtime.ts
import { HeavyService } from './HeavyService';  // static — only pulled into this chunk
import type { AddonContext, AddonRuntime } from '../AddonLoader';

export class MyAddonRuntime implements AddonRuntime {
  public service: HeavyService | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return;
    this.service = HeavyService.getInstance();
    await this.service.init();
  }

  async destroy(): Promise<void> {
    if (!this.service) return;
    this.service.destroy();   // see destroy contract below
    this.service = null;
  }
}

export default new MyAddonRuntime();
```

## Core code accessing a runtime

Core code **never** statically imports heavy addon modules. It imports:
1. The cheap flag accessor from `<id>/index.ts` (if needed at all).
2. The runtime class as a **type-only import** (erased at build time).
3. The runtime instance through `AddonLoader.getRuntime<T>(id)`.

```ts
import { AddonLoader } from '../addons/AddonLoader';
import type { MyAddonRuntime } from '../addons/<id>/runtime';

function doStuff() {
  const rt = AddonLoader.getInstance().getRuntime<MyAddonRuntime>('<id>');
  if (rt?.service) {
    rt.service.checkSomething(...);
  }
}
```

**Do not cache `rt.service` in a long-lived field.** Fetch it fresh at each call site so toggle-off and account switches are picked up transparently.

## Destroy contract (mandatory)

Every `runtime.destroy()` and every singleton service's own `destroy()` MUST fully unwind:

- `removeEventListener` for every `addEventListener` (same function reference, same options)
- `clearInterval` / `clearTimeout` for every `setInterval` / `setTimeout`
- `EventBus.off()` for every subscription id returned by `.on()`
- Detach / empty every DOM node the addon mounted
- Drop every cache / store reference so it becomes GC-eligible
- Singleton services: null the static `instance` so the next `getInstance()` returns a fresh instance (important on account switch — state must not leak across accounts)
- Set a `destroyed` / cancel flag so in-flight async callbacks do not write post-destroy state

Reviewers: block any `destroy()` that does not demonstrably satisfy every applicable bullet.

## Toggle events

When the Settings UI flips an addon flag, it MUST emit the AddonLoader event:

```ts
EventBus.getInstance().emit('<id>:addon-toggle', { enabled: checked });
```

The `<id>` is the registry id in `registry.ts`. For addons that had a legacy event name (e.g. `marketplace:toggle`, `custom-emojis:toggle`, `follow-packs:toggle`, `content-word-filter:toggle`), dual-emit both so existing listeners keep working:

```ts
const bus = EventBus.getInstance();
bus.emit('<id>:addon-toggle', { enabled: checked });  // AddonLoader
bus.emit('<id>:toggle', { enabled: checked });        // legacy
```

## No-op runtimes

Addons whose heavy code is already correctly on-demand lazy (no singleton, no timer, no listener — e.g. `live-streams-player`, `wordfilter`, `marketplace`, `follow-packs`) have a no-op `runtime.ts` with empty `init` / `destroy`. They still participate in AddonLoader for uniform lifecycle tracking and DiagLog coverage. Document why in the file header so future work knows it's intentional.

## Out of scope (intentionally excluded)

**Bookmarks and Tribes stay in `src/lists/*.ts`** — their managers are tightly coupled to `AutoSyncService`, which handles the 10s-initial / 5-min-periodic sync for Mutes/Follows/Bookmarks/Tribes. That sync semantics is fragile (see `docs/features/lists.md` history of Sync Bug Fixes). They remain UI-gated via flag imports like before. The ~7000 LOC they contribute to the bundle is the deliberately chosen price for zero risk to the lists architecture.

**List-settings, extended-follows, mypage** are list-adjacent addons whose migration was deferred. Any decision to include them is a separate project.

## Diagnose

```bash
python3 diagnose/addons_lifecycle.py ~/.noornote/{npub}/logs/
```

Reports per-addon load/init/destroy counts, account switches, errors, orphaned lifecycle transitions (init without destroy and vice versa). Parses the `addons` area of the DiagnosticLogger.

## Full plan & history

`docs/todos/addons-true-lazy-loading.md`
