---
name: git-commit
description: Splits the current changes into small, logically-grouped git commits and commits them under the human git account. Use whenever the user asks to commit, make commits, or split changes into commits in this repository.
license: MIT
---

# Git commit

Turn the working tree's changes into a sequence of small commits, each scoped to one logical/semantic group, authored as the human — never as Claude.

## 1. Never attribute a commit to Claude (HARD rule)

Every commit made through this skill must be indistinguishable from one the human wrote themselves. This is a hard rule — always apply it, not a style preference to weigh against other concerns.

- Do **not** add a `Co-Authored-By: Claude ...` trailer (or any Claude/Anthropic co-author trailer) to the commit message, even though the default global instructions for this harness normally append one. This skill's instructions override that default.
- Do **not** change `user.name` / `user.email` (local or global git config) to anything Claude-related. Commit under whatever identity `git config user.name` / `user.email` already resolve to for this repo (check with `git config user.name && git config user.email` if unsure — do not assume).
- Do **not** mention Claude, Anthropic, or AI authorship anywhere in the commit message body.
- Write commit messages in the voice and style the human already uses in this repo's history (check `git log -n 10` for tone — imperative subject line, wrapped body, rationale over restatement of the diff).

## 2. Split changes into small, logically-grouped commits (HARD rule)

Never pile unrelated changes into one commit. This is a hard rule — always apply it, not a style preference to weigh against other concerns.

A "logical group" is a set of changes that share one reason for existing — one feature slice, one bug fix, one refactor, one config/dependency bump, one docs update. If you'd need "and" to describe a commit's purpose in one short sentence, it's probably two commits.

### Process

1. **Survey first.** Run `git status` and `git diff` (plus `git diff --staged` if anything is already staged) to see the full scope of changes before grouping anything. Never stage or commit blind.
2. **Partition by meaning, not by file.** Group changed hunks by what they're *for*: a new feature and its tests are one group; an unrelated formatting fix or a bumped dependency is a separate group, even if it sits in a file that's also part of the feature group.
3. **Stage each group precisely.**
   - Whole files that belong to one group: `git add <path> <path> ...` (never `git add -A` or `git add .` — that erases the grouping and can sweep in unrelated or sensitive files).
   - A single file containing hunks from more than one group: use `git add -p <path>` and select only the hunks for the group currently being committed.
4. **Verify the stage before committing.** `git diff --staged` must contain exactly this group's changes — nothing more, nothing less. If a hunk doesn't belong, unstage it (`git restore --staged <path>` or deselect it in `-p`) before moving on.
5. **Commit with a message via heredoc**, following this repo's existing log style, and with no Claude/Anthropic trailer:
   ```bash
   git commit -m "$(cat <<'EOF'
   <imperative subject line>

   <body explaining why, wrapped to ~72 cols, matching existing log tone>
   EOF
   )"
   ```
6. **Repeat** survey → partition → stage → verify → commit for each remaining group until the working tree is clean (or only intentionally-excluded changes remain).
7. **Final check.** Run `git log --oneline -n <N>` and `git status` to confirm every group landed as its own commit, in a sensible order (e.g. foundational/dependency changes before the code that relies on them), and nothing was left uncommitted by accident.

### Ordering and granularity guidance

- Prefer an order where each commit leaves the tree in a working state on its own (dependency bump → code that uses it → tests, not interleaved).
- Don't over-split: a small, cohesive change (e.g. one function plus its one test) is one commit, not two. The goal is logical clarity, not maximum commit count.
- If a change is genuinely a single indivisible unit (e.g. a renamed symbol touching many files for one reason), one commit is correct — "small" means scoped to one reason, not an arbitrary line-count ceiling.

## 3. Standard git-safety rules still apply

- Never use `--no-verify`, `--no-gpg-sign`, or skip hooks.
- Never `git add -A`/`git add .` — stage explicitly per the process above.
- If a pre-commit hook fails, fix the underlying issue and retry; don't bypass it.
- Never force-push or rewrite history as part of this skill.
- Only commit what the user asked to have committed; if unrelated untracked/dirty state is discovered that the user didn't ask about, point it out rather than silently sweeping it into a commit.
