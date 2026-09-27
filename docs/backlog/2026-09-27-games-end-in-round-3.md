# Live games never reach rounds 4 and 5

Observed in the weekly tuning pass on 2026-09-27. All four live games this
week (20260922-1023-7a59, 20260922-1313-d901, 20260923-1309-4d3f,
20260924-1318-5ee9) ended after round 3 with an empty table and nothing
rotted: 8 treasures, 3 per proposal, and every proposal passed.

Consequences:

- Persona clauses about "the final round" and "the last two rounds" never
  trigger, so the rot threat and end-game behaviour are untested.
- Round 3 is always a two-item proposal decided by who holds nothing yet.

Possible changes, each behind `GameConfig` with a test and without changing
games on disk: `maxPerProposal: 2`, more treasures than 8, or a failed vote
rotting more than one item. Not changed in this pass.
