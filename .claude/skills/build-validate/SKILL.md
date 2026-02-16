---
name: build-validate
description: Run code-simplifier, build checks and cargo check before committing. Use before every commit.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(bun *), Bash(cargo *), Bash(git diff *), Task(code-simplifier:code-simplifier)
---

# Build & Validate Workflow

Run all checks before a commit. Every step must pass with zero errors/warnings.

## Steps

1. **Code Simplifier** (mandatory, skip only if user says "skip simplifier")
   Launch Task tool with `subagent_type: "code-simplifier:code-simplifier"` (FULL name, not just "code-simplifier").
   Run on all modified files. Ensures DRY code, no redundant logic, clean helpers.

2. **Code Hygiene Checks** (on modified .ts files only)
   Use `git diff --name-only HEAD` to get modified .ts files, then use Grep tool on those files:

   a. **`debugger` statements** → FAIL if found. Must be removed.
   b. **TODO / FIXME / HACK / XXX** → FAIL if found. Per CLAUDE.md: "No TODOs in code".
   c. **`console.log`** → FAIL if found. Must be `console.debug()` (DevTools) or `systemLogger.*()` (System Log).
   d. **`console.warn`** → FAIL if found. Same rule: `console.debug()` or `systemLogger.*()`.
   e. **`console.info`** → FAIL if found. Same rule.

   Exception: `console.error` is allowed (intercepted for relay error handling in SystemLogger).
   If no modified .ts files exist, skip this step.

3. **Log Review** (on modified .ts files only)
   Execute `/log-review` skill logic on modified files:

   a. **`systemLogger.*()` calls** → Verify messages are Hollywood-style, human-readable, user-worthy.
      Flag technical jargon, hex IDs, JSON dumps, or overly verbose messages.
   b. **Suggest promotions** → If a `console.debug` message would be interesting to the user,
      suggest adding a `systemLogger` call with Hollywood-style wording.
   c. Present findings and apply fixes on user approval.

   If no modified .ts files exist, skip this step.

4. **TypeScript Build**
   ```bash
   bun run build
   ```
   Zero errors and zero warnings required (includes strict mode check).

5. **Rust Check**
   ```bash
   cd src-tauri && cargo check
   ```
   Zero errors and zero warnings required.

6. If all checks pass, report success. If any fail, fix issues and re-run.
