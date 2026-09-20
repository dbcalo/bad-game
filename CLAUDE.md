@AGENTS.md

## Claude Code specifics

- Player subagents are spawned with the `Agent` tool using the `model` from the agent's definition file, and continued with `SendMessage` (load it with ToolSearch `select:SendMessage` first).
- Simultaneous phases (whispers, votes) may be sent to all players in one message; discussion and proposal are sequential.
- Commit after every round so the site shows the game in progress.
