---
name: git-commit
description: Analyze current changes, split them into logical commits with Conventional Commits messages, present a plan for user confirmation, then execute.
argument-hint: "Any specific instructions for commit grouping or message style"
---

# Skill: git-commit

Analyze `git status` and `git diff` to split uncommitted changes into **logical commits**, each with a Conventional Commits message. Present the plan, let the user confirm/modify, then execute.

## Process

### 1. Gather context

Run these commands in parallel:

- `git status --short` — staged and unstaged files at a glance
- `git diff --cached --stat` — what's staged
- `git diff --stat` — what's unstaged
- `git log --oneline -10` — recent commit history for style reference
- `git diff --cached` + `git diff` — full diff content for analysis
- `git ls-files --others --exclude-standard` — untracked files

Understand:
- Which files are tracked/modified/staged/untracked
- The project's language, framework, and module layout
- The commit message style from recent history (to match tone)

### 2. Design the commit plan

Read every hunk of the diff. Group related changes into logical commits. Heuristics:

| Signal | Likely group |
|---|---|
| All changes in one module/package | Same commit |
| Bug fix + test for that fix | Same commit (`fix:` + test in body) |
| Refactor without behaviour change | `refactor:` commit |
| New feature + its tests | `feat:` commit |
| Formatting/whitespace across several files | `style:` commit (isolated!) |
| Changes touching completely unrelated domains | **Separate commits** |

For each group, determine:

- **Type** — `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `perf`, `ci`, `build`, `revert`
- **Scope** (optional) — the module/component affected, e.g. `feat(api):`, `fix(parser):`
- **Short description** — imperative mood, lowercase, no trailing dot, ≤ 72 chars
- **Body** (optional) — what and why, wrapped at 72 chars
- **Breaking change** — append `!` after type/scope and add `BREAKING CHANGE:` in body

List the files (and key hunks) for each proposed commit so the user can see what goes where.

### 3. Present the plan

Show the user a structured plan like:

```
📦 Proposed Commit Plan
━━━━━━━━━━━━━━━━━━━━━━━

Commit 1: feat(parser): add support for CSV import
  Files: src/parser/csv.py, tests/test_parser.py
  └── New CSV parser module + integration test

Commit 2: fix(auth): handle token expiry gracefully
  Files: src/auth/middleware.py
  └── Add refresh-token fallback on 401

Commit 3: chore(deps): upgrade requests to 2.32.0
  Files: pyproject.toml
  └── Security patch for CVE-2024-…


❓ Options:
  [A]ccept and commit         — execute the plan as-is
  [E]dit plan                 — propose modifications
  [R]egroup files             — move files between commits
  [C]ustomize message         — rewrite a specific message
  [S]kip a commit             — exclude a group from this batch
  [Q]uit / cancel             — abort, leave everything uncommitted
```

### 4. Let the user iterate

Accept free-form instructions. Examples:

- "Move `utils/helpers.py` from Commit 2 to Commit 1"
- "Change Commit 3 message to `chore: bump requests`"
- "Drop Commit 4 entirely, I'll do it later"
- "Add a body to Commit 1 explaining the design choice"

Regenerate the plan after each edit until the user says **Accept**.

### 5. Execute

For each commit **in dependency order** (foundational changes first):

```bash
git add <file1> <file2> ...
git commit -m "type(scope): description" -m "body (if any)"
```

Never commit untracked files without explicit user approval. If a file is untracked, flag it and ask before adding.

If a commit fails (hooks, lint), stop and report the error — don't continue with remaining commits.

### 6. Confirm

Print a summary of what was committed:

```
✅ Committed 3 changes:
  a1b2c3d feat(parser): add support for CSV import
  e4f5g6h fix(auth): handle token expiry gracefully
  i7j8k9l chore(deps): upgrade requests to 2.32.0
```

## Output conventions

- Use **Conventional Commits 1.0** format
- Use imperative mood (`add`, `fix`, `remove` — not `added`, `fixes`, `removing`)
- Keep the title line ≤ 72 characters
- Wrap body at 72 characters
- Separate body from title with a blank line
- Use `BREAKING CHANGE:` in the body footer for breaking changes
- Reference issues with `#123` in the body when evident from the diff