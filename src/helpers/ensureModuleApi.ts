/**
 * Module API resolution for views that can mount before modules finish.
 *
 * Views mounted by the Focus UI shell construct at boot on deep-link
 * reloads — possibly BEFORE the login-activated modules finish their
 * async init. A plain ModuleLoader.getApi() is null then, and a view
 * that treats null as "nothing to fetch" shows its empty state forever
 * (no retry). Every module-backed fetch in a view that can be
 * constructed at boot MUST resolve its API through this helper — it
 * waits for the module init instead of returning null (a no-op once the
 * module is loaded, so classic-lifecycle views behave identically).
 */
import { ModuleLoader } from '../core/ModuleLoader';

export function ensureModuleApi<T>(id: string): Promise<T | null> {
  return ModuleLoader.getInstance().ensure<T>(id);
}
