---
name: push
description: Merge development into main, push to remote, return to development branch. Only use when user explicitly says "push".
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *)
---

# Git Push Workflow

Merge development into main, push, and return to development.

## Steps

1. Run: `git checkout main && git merge development && git push && git checkout development && git push origin development`
2. Confirm: "Back at development branch. Awaiting instructions."
