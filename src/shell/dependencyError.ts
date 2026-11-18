/**
 * Dependency error reporting (v2) — the missed-edge detector.
 *
 * The dependency graph (focusDependencyGraph.ts) is hand-maintained; an
 * edge can be forgotten. When that happens, a domain gets hidden (its
 * code fully unloaded) while a VISIBLE domain still exercises its
 * functionality — the user sees the breakage, we need to see the CAUSE.
 *
 * Every stilllegung gate (addon load attempt, machinery activation, seam
 * route into a hidden owner) calls reportDependencyError() when it is
 * reached although its domain is hidden. The `DEPENDENCY ERROR` marker
 * makes the log greppable; the fix is always: add the missing edge to
 * FOCUS_DOMAIN_REQUIRES (+ mirror in docs/todos/dependency-graph.md).
 */

import { diagLog } from '../services/DiagnosticLogger';

/** Emit a greppable dependency error (diagnostics + devtools console). */
export function reportDependencyError(
  /** The visible domain / component that exercised hidden functionality. */
  consumerId: string,
  /** The hidden domain whose functionality was reached. */
  hiddenDomainId: string,
  /** What exactly was reached (view type, module id, timer origin…). */
  detail: string
): void {
  const msg =
    `DEPENDENCY ERROR: "${consumerId}" used functionality of hidden ` +
    `object "${hiddenDomainId}" (${detail}) — missing requires edge, ` +
    'add it to shell/focusDependencyGraph.ts';
  diagLog('system', msg, { consumerId, hiddenDomainId, detail });
  console.error(`[NoorNote] ${msg}`);
}
