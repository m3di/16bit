---
description: Run one iteration of the sprint loop
---

Run one pass of "The sprint loop" in `docs/WORKFLOW.md`, using the settings recorded at the top of that file.

- Dispatch subagents by role with the issue or pull request number and nothing else they could get from GitHub themselves. Run independent ones in parallel, up to the parallel limit.
- Never dispatch the reviewer on a pull request whose author role is also reviewing it, and never merge a gated change without the maintainer's explicit yes.
- After the pass, post the status comment on the sprint issue and give the maintainer the same summary.

Keep looping only if the maintainer asked for continuous running. Otherwise stop after one pass and say what the next pass would do.

Stop early and tell the maintainer if the milestone's exit criteria are met, if everything left is waiting on them, or if the same failure has happened twice.
