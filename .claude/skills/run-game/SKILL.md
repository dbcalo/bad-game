---
name: run-game
description: Run one live game of The Table with language-model players as subagents, commit the transcript after every round, and push it to main. Use when asked to run, play, or host a game.
---

# Run a live game

You are the table runner. The engine (`npm run game -- …`) is the referee.
Your job is transport: render each player's view, hand it to that player's
subagent, and feed the reply back. Do not play for the players, do not edit
their replies, and do not comment on the game to them.

## 0. Setup

```
cd /home/user/bad-game || { echo "clone first"; exit 1; }
git fetch origin main && git checkout main && git pull --ff-only origin main
npm ci
npm run game -- validate-agents
mkdir -p .tmp
```

If the repo is not on disk, call `add_repo` for `dbcalo/bad-game` with push
access, clone it to `/home/user/bad-game`, and continue.

Load the `SendMessage` tool: ToolSearch with `select:SendMessage`.

## 1. Create the game

```
ROSTER=$(npm run -s game -- roster)
ID=$(npm run -s game -- new --agents "$ROSTER")
npm run game -- next "$ID"
git add games && git commit -qm "game: start $ID" && git push -q origin main
```

## 2. Spawn one subagent per player

For every agent id in `$ROSTER`, read its `model` from `agents/<id>.md`
frontmatter (`haiku`, `sonnet`, `opus`, or `fable`) and spawn a subagent with
the `Agent` tool:

- `subagent_type`: `general-purpose`
- `model`: the agent's model
- `run_in_background`: `false`
- `description`: `Player <id>`
- `prompt`: exactly this, with the full prompt appended:

```
You are a player in a negotiation game. Below are the rules, who you are,
and the current situation. You will receive one message per turn. Each time,
your ENTIRE final message must be ONE JSON object in the format the message
asks for: no prose, no code fences, no summary of what you did, no
commentary before or after. Do not use any tools. Play to win. Stay in
character. Never mention being an AI or a subagent.

<output of: npm run -s game -- prompt "$ID" <id> --full>
```

The subagent's first reply is its first action only if it is currently its
turn; otherwise ignore it and wait for step 3. To avoid that ambiguity, spawn
each player right before its first turn: the first speaker now, the others
when the engine first asks for them.

Keep a table of agent id → subagent id/name for `SendMessage`.

## 3. Loop until the game ends

Repeat:

1. `npm run -s game -- next "$ID"` gives `phase` and `pending` (one or more agents).
2. For each pending agent, get the text with
   `npm run -s game -- prompt "$ID" <agent>` (delta view; use `--full` only for a freshly spawned subagent, where the prompt is already part of the spawn message).
3. Send it to that player's subagent with `SendMessage`. When several agents
   are pending (whispers, votes), send all of them in one response and wait.
4. Save each reply verbatim to `.tmp/<agent>.json` and apply it:
   `npm run -s game -- act "$ID" <agent> .tmp/<agent>.json`
5. If the CLI prints `REJECTED: <reason>` (exit code 3), or the subagent
   hands back a summary instead of its move, send the player exactly:
   `Your reply was rejected: <reason>. Send the exact JSON object as your entire final message, nothing before or after it.`
   and retry. After 3 rejections for the same turn, apply
   `npm run -s game -- fallback "$ID" <agent>` and move on.
6. Whenever the round number in `game status` increases, or the game ends:
   `git add games data && git commit -qm "game: $ID round N" && git push -q origin main`

Stop when `game next` reports `"phase": "ended"`.

## 4. Finish

```
npm run game -- rebuild
git add games data && git commit -qm "game: $ID finished" && git push -q origin main
npm run game -- show "$ID" | tail -40
```

## 5. Republish the phone viewer

The replay viewer also lives as a claude.ai artifact with the games embedded
(the GitHub Pages site needs a setting the owner could not reach). After
every finished game, rebuild it and republish to the same URL:

```
npm run build:artifact        # writes dist/artifact.html with all live games embedded
```

Then, with the Artifact tool: `action: "read"` with `url` set to the value of
`artifactUrl` in `package.json` (a publish to an artifact this session has not
read is refused), then `action: "publish"` with that same `url` and
`file_path: dist/artifact.html`. Omit `icon` and `capabilities` so the
artifact keeps what it has. If the Artifact tool is not available in this
session, skip this step and say so in the report.

Report in one short paragraph: who won, the score line, and the single most
entertaining moment (a lie, a flip, a poison hand-off). Link the replay in
the artifact: `<artifactUrl>#/g/$ID`.

## Rules for the runner

- Never paraphrase, fix, or shorten a player's JSON. Save it exactly and let the engine judge.
- Never tell one player what another player said outside the engine's prompt.
- If a subagent stops responding, respawn it with a `--full` prompt and continue. Its earlier notes are in the game file; it will not remember them, which is acceptable.
- If a push is rejected (someone else pushed), `git pull --rebase origin main` and push again. Game files never conflict because each game has its own file; `index.json` and `leaderboard.json` are regenerated with `game rebuild` after the pull.
- Do not run more than one game per session unless asked.
