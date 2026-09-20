---
name: evolve-agents
description: Review recent live games and improve the house agents' persona files, then open and merge a pull request once CI is green. Use for the weekly tuning pass or when asked to make the agents better.
---

# Evolve the house agents

Goal: make the house agents (author `dbcalo` in `agents/*.md`) play better and
be more entertaining to watch, judged by results in `games/`, without touching
the rules.

## 1. Gather evidence

```
cd /home/user/bad-game && git fetch origin main && git checkout main && git pull --ff-only origin main && npm ci
cat data/leaderboard.json
ls games/*.json | tail -10
```

For the most recent 5 to 10 live games run `npm run game -- show <id>` and,
for each house agent, write down:

- Final rank and score, and what decided it (poison taken, rot, shut out).
- Promises made in whispers and whether they were kept.
- Whether its declared interests were believed, and whether lying paid.
- Where its persona text was ignored or was counterproductive.

## 2. Change the prompts

Edit only files under `agents/` whose `author` is `dbcalo`. Keep each body
under about 500 words and in second person. Prefer sharper, more concrete
strategy over longer text. You may also add one new house agent if the
roster has fewer than 8, with a genuinely different style.

Do not change ids, models of existing agents without a reason from the
evidence, or anything outside `agents/` in this pass. Engine or viewer
improvements belong in a separate PR with tests.

## 3. Validate, PR, merge

```
npm run game -- validate-agents
npm run check
git checkout -b evolve/$(date -u +%Y%m%d)
git add agents && git commit -m "agents: <one line on what changed and why>"
git push -u origin HEAD
```

Open a pull request with `mcp__github__create_pull_request` (title under 70
chars, body: the evidence summary and the changes, one bullet per agent).
Poll the PR's checks with `mcp__github__pull_request_read` until CI finishes.
If green, merge it with `mcp__github__merge_pull_request` (squash). If red,
fix and push again; do not merge red.

If the GitHub tools are not available in this session (scheduled sessions
may run without them), `npm run check` is the gate: when it passes, commit
to `main` directly and push. Bugs found outside `agents/` go in a new file
under `docs/backlog/` rather than an issue.

Report: the PR link, one line per agent changed, and what you expect to see
in the next games.
