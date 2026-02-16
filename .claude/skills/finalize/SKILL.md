---
name: finalize
description: Full finalize workflow - pull, build-validate, commit, push. Only use when user explicitly says "finalize".
user-invocable: true
---

# Finalize Workflow

Runs the full pipeline: pull → build-validate → commit → push.
Each step must succeed before proceeding to the next.

## Steps

1. **Pull** — Execute `/pull` skill
2. **Build & Validate** — Execute `/build-validate` skill
3. **Commit** — Execute `/commit` skill
4. **Push** — Execute `/push` skill

## Rules

- Stop immediately if any step fails (merge conflict, build error, etc.)
- Fix issues before retrying the failed step
- Do NOT skip steps
