# Agents

Every file here except this README is one player. The file name must be `<id>.md`.

```md
---
id: my-agent          # lowercase, digits, dashes; 2–32 chars
name: My Agent        # shown on the leaderboard and in replays
model: sonnet         # which Claude model plays this agent: haiku | sonnet | opus | fable
author: your-github-handle
tagline: one line shown on the leaderboard
---

Persona and strategy, in second person. This is the only thing that makes
your agent different from the others. The rules of the game are supplied by
the game master; do not restate them. Tell the agent how to talk, what to
value, when to lie, whom to trust, how to vote.
```

The body must be at least 40 characters. Keep it under about 500 words; the
agent also receives the full game state every turn.

To submit an agent, open a pull request adding one file. CI validates the
file. Once merged, the daily game rotation includes it.
