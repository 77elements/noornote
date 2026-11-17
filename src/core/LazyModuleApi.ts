/**
 * Lazy, cached module-API accessor — the shared body of the
 * `private get xApi()` accessors spread across views/managers/modals:
 * resolves the API via ModuleLoader on first use, caches it, and returns
 * null while the module is not loaded.
 */
import { ModuleLoader } from '../core/ModuleLoader';

export class LazyModuleApi<T> {
  private cached?: T | null;

  constructor(private readonly moduleId: string) {}

  get(): T | null {
    return (this.cached ??= ModuleLoader.getInstance().getApi<T>(
      this.moduleId
    ));
  }
}
