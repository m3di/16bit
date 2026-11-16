# Kickoff

One-time setup, run by the lead session through `/kickoff`. Work through the steps in order. Do not skip the questions in step 1.

## 1. Ask the maintainer

Ask these in one message and wait for the answers:

1. **Repository:** which GitHub owner and name? Default: `m3di/16bit`, public.
2. **Copyright name:** `NOTICE` currently says "Mehdi Heidari". Keep or change?
3. **Merge mode for M0:** `lead` (the lead merges a pull request once CI is green and the reviewer has approved) or `human` (the maintainer merges every pull request). Default: `lead`, with `needs-human` gates still enforced.
4. **Parallelism:** how many subagents may run at once? Default: 3.

Record the answers at the top of `docs/WORKFLOW.md` under "Settings".

## 2. Check the tools

Confirm that `git`, `gh` (authenticated), `node`, `pnpm`, and `docker` are available. If one is missing, say which and stop.

## 3. Create the repository

1. `git init` with `main` as the default branch.
2. Commit the kit as it is: `Add project brief, roadmap, and agent team setup`.
3. Create the GitHub repository with `gh repo create`, using the owner, name, and visibility from step 1, and push `main`.
4. Set the repository description to the first line of `README.md`.

## 4. Set up the board

1. Create the labels listed in `docs/WORKFLOW.md` ("Labels").
2. Create the milestone `M0 first look`.
3. Create one issue per entry in `team/backlog.md`, in order, with its role label, `stage:todo`, the milestone, and its dependencies written as issue references once the numbers exist.
4. Post the sprint goal as a pinned issue titled `Sprint 0: first look`.

From this point GitHub is the source of truth for tasks. `team/backlog.md` stays as the record of the initial plan and is not edited again.

## 5. Protect main

Branch protection needs a CI check to require, so it is switched on by issue M0-02 once the first workflow exists: require the CI checks to pass, require linear history, and block force pushes. Do not require approving reviews, because every agent acts through the maintainer's account and GitHub does not allow approving your own pull request. Review approval is tracked with the `review:approved` label instead.

## 6. Start the sprint

Run `/sprint`. Repeat until the M0 exit criteria in `docs/ROADMAP.md` are met, pausing whenever an issue is labelled `needs-human`.

## 7. First look

When M0 is done:

1. Write `docs/reports/M0.md`: what works, how to run it, what was cut, open questions, and what the team would change about the workflow.
2. Update the "Running it locally" section of `README.md` with the exact commands.
3. Tell the maintainer it is ready and stop. Do not start M1 until the maintainer has looked and given feedback.
