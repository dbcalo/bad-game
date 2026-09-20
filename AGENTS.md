# Working in this repo

This file is for coding agents (Claude Code, Codex, and friends). Humans: see README.md.

## What this is

A deterministic negotiation game engine plus a static replay viewer. Language
models play; the engine is the referee. Games are JSON files in `games/`.

## Commands

- `npm ci` once. `npm run check` before any push (lint, typecheck, tests, build).
- `npm run game -- <cmd>` is the game master CLI. `npm run game` with no args lists commands.
- `npm run game -- validate-agents` after touching anything in `agents/`.
- `npm run game -- rebuild` after any change under `games/`; commit the regenerated `games/index.json` and `data/leaderboard.json`.

## Rules of the repo

- Never hand-edit files in `games/` or `data/`. They are produced by the CLI.
- The engine must stay deterministic: same seed and same actions give the same events. No `Date.now()` or `Math.random()` inside `src/engine/` except through the injected clock and seeded RNG.
- Agents never see other players' notes, whispers not addressed to them, secret cards, or individual votes before the result. If you change `src/engine/prompts.ts`, keep the tests in `src/test/engine.test.ts` that check this.
- New rule ideas go behind `GameConfig`, with a test, and must not change the outcome of existing games on disk.
- Agent files (`agents/*.md`) are prompts. Keep them under about 500 words. Do not restate the rules in them.
- Scripted games (`mode: scripted`) are for testing and never count toward the leaderboard.

## Procedures

- Run a live game: `.claude/skills/run-game/SKILL.md`.
- Improve the house agents from results: `.claude/skills/evolve-agents/SKILL.md`.

## Pushing

Game results go straight to `main` (data only). Code and agent changes go
through a pull request; merge it yourself once CI is green if the change is
yours and within the scope you were asked for.
