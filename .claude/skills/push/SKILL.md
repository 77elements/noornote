---
name: push
description: Merge development into main, push to remote, return to development branch. Only use when user explicitly says "push".
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *)
---

# Git Push Workflow

Merge development into main, push, and return to development.

## Dev-only files

These files/directories exist ONLY on development and must be removed from main after every merge:
- `CLAUDE.md`
- `docs/`
- `screenshots/`
- `.claude/`

## Steps

1. Merge development into main:
   ```
   git checkout main && git merge development
   ```

2. Remove dev-only files from main and commit:
   ```
   git rm -rf CLAUDE.md docs/ screenshots/ .claude/ 2>/dev/null && git commit -m "Remove dev-only files from main"
   ```
   If nothing to remove (already clean), skip the commit.

3. Push both branches:
   ```
   git push && git checkout development && git push origin development
   ```

4. Confirm: "Back at development branch. Awaiting instructions."
