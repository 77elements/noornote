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
   c. **`console.log`** → WARN. Show matches. Legitimate uses: tagged loggers (`[ServiceName]`), debug utilities, doc comments. Leftover debug logs (emoji prefixes, bare messages) should be flagged for review.

   If no modified .ts files exist, skip this step.

3. **TypeScript Build**
   ```bash
   bun run build
   ```
   Zero errors and zero warnings required (includes strict mode check).

4. **Rust Check**
   ```bash
   cd src-tauri && cargo check
   ```
   Zero errors and zero warnings required.

5. If all checks pass, report success. If any fail, fix issues and re-run.
