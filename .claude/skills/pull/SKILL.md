---
name: pull
description: Pull latest changes from remote for both main and development branches. Only use when user explicitly says "pull".
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *)
---

# Git Pull Workflow

Pull latest changes from remote for both branches, return to development.

## Steps

1. Run: `git checkout main && git pull && git checkout development && git pull`
2. Confirm: "Both branches up to date. Back at development branch."
