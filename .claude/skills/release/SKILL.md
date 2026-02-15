---
name: release
description: Generate release notes from commits and run release script. Tauri desktop only.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *), Read, Grep, Glob, Write
---

# Release Workflow

Generate human-readable release notes and execute the release.

## Steps

1. **Generate Release Notes** (two files)
   - Get the previous version tag: `git tag --sort=-v:refname | grep '^v' | head -1`
   - Collect commits since that tag: `git log <prev-tag>..HEAD --oneline --no-merges`
   - Ask user for version number if not provided

   **Detailed** → `docs/release-notes-{VERSION}.md` (internal archive)
   - Group commits into categories (Auth, UI, DMs, Lists, Desktop, Fixes, etc.)
   - One line per change, no commit hashes, no "Bump version" commits
   - Merge related commits into single entries

   **Compact** → `docs/release-notes-{VERSION}-compact.md` (GitHub Release → Update Modal)
   - Max 1-2 lines per category, user-facing language
   - No internal details (refactoring, code cleanup, etc.)
   - This is what end-users see in the desktop update notification

   - Show both to the user for review/edits before proceeding

2. After user approves both files, finish with:
   "You can now execute `./deployment/release.sh`"

## Rules

- Wait for user approval of BOTH release notes before finishing
- Never fabricate changes not in the commits
