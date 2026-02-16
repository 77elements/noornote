---
name: log-review
description: Review System Log messages for user-friendliness (Hollywood-style). Run as part of /build-validate or standalone.
user-invocable: true
allowed-tools: Grep, Read, Edit, Glob, Bash(git diff *)
---

# System Log Review

Review logging in modified files. Enforce the two-tier logging architecture:

## Architecture

| Target | Method | Audience | Tone |
|--------|--------|----------|------|
| **System Log** (in-app) | `systemLogger.info/warn/error/success()` | User | Hollywood-style, human-readable |
| **DevTools Console** | `console.debug()` | Developer | Technical, detailed |

## Rules

1. **System Log messages must be Hollywood-style:**
   - Short, confident, human-readable
   - No hex IDs, no stack traces, no JSON dumps
   - Use action verbs: "Connected", "Syncing", "Ready"
   - Success feels rewarding: "Timeline loaded — 26 notes ready"
   - Errors feel informative, not scary: "Relay offline: nos.lol"
   - The user should feel like they're watching a cool system work

2. **Console-only messages (`console.debug`):**
   - Technical debug info (IDs, payloads, filter objects)
   - Internal state transitions
   - Performance timings
   - Anything with hex strings, JSON, or stack traces

3. **NEVER use `console.log()` or `console.warn()` in app code:**
   - These get intercepted and could leak to System Log
   - Use `console.debug()` for DevTools-only output
   - Use `systemLogger.*()` for user-facing output
   - Exception: third-party code we don't control

## Steps

1. Get modified .ts files via `git diff --name-only HEAD`
2. In each modified file, search for:
   - `systemLogger.` calls → Check if message is Hollywood-style and user-worthy
   - `console.log(` → Flag as violation (should be `console.debug` or `systemLogger`)
   - `console.warn(` → Flag as violation (should be `console.debug` or `systemLogger`)
   - `console.info(` → Flag as violation (should be `console.debug` or `systemLogger`)
3. For each finding:
   - **Too technical for System Log?** → Move to `console.debug()`
   - **User-relevant but poorly worded?** → Suggest Hollywood-style rewrite
   - **Missing from System Log?** → Suggest adding `systemLogger` call if user-relevant
4. Present findings and apply fixes on user approval
