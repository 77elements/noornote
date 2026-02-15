---
name: commit
description: Commit all changes with a short message. Only use when user explicitly says "commit" or "feature ok".
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *)
---

# Git Commit Workflow

Commit all staged and unstaged changes.

## Rules

- **Trigger:** ONLY on explicit user approval ("commit" / "feature ok")
- **Format:** `git add . && git commit -m "[msg]"`
- **Message style:** Short one-liner, no prefixes, no scopes
- NO selective adds
- NO `git log`
- NO `git diff` before or after
- NO Claude signatures or Co-Authored-By
- NEVER mention other client names in commits or code

## Steps

1. Run `git add . && git commit -m "$ARGUMENTS"` (if user provided a message)
2. If no message provided, write a short descriptive one-liner based on the work done
3. Done. Say nothing extra.
