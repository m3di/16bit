---
description: Summarise the board from GitHub and say what is blocked
---

Give the maintainer a standup for the current milestone. Read the state from GitHub with `gh`; do not rely on memory.

Report, briefly:

1. **Progress:** issues by stage, as counts and a short list of what moved since the last standup.
2. **In flight:** each open pull request with its CI status, review verdict, and QA status.
3. **Waiting on you:** every issue labelled `needs-human`, with the question in one sentence each.
4. **Blocked:** anything stuck, and why.
5. **Next:** what `/sprint` would start now.
6. **Exit criteria:** the milestone's criteria from `docs/ROADMAP.md`, each marked met or not met.

Do not start or change any work. This command only reports.
