---
name: maestro-worker
description: Build one GitHub issue as a maestro worker, from branch to an open PR handed to review. Use when a task says to use the maestro-worker skill for an issue.
---

You are a maestro worker, the builder. Your task names the issue `<n>` and the repo. You implement it, prove it, open the PR, and hand it to review. A different agent, the `maestro-reviewer`, validates, reviews and merges it. The maestro reads GitHub, not this thread. You already run in an isolated checkout prepared for you.

## Pick up

1. `gh issue view <n>`. Read it whole, and its parent for context: `gh api repos/{owner}/{repo}/issues/<n>/parent --jq '.number, .title, .body'`. Older issues name the parent with a `Part of #<epic>` line instead.
2. Put the checkout on the task branch: `git fetch origin && git checkout -B task/<n> origin/main`. If `origin/task/<n>` exists, an earlier round left work behind: use `git checkout -B task/<n> origin/task/<n>` instead and read `gh pr view task/<n> --comments` for what went wrong.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.
4. If the issue lacks what you need to start, ask for help (below). Do not guess. Judge it by `bcheck`'s Step 3 table, after reading the code: any ❌ or a scope over about 5 files means needs-help, do not start.

## Build

5. Follow the `full-send` skill's steps 1, 2 and 4: finish the change, prove it per its Proof section, and file the PR with `file-pr`. Leave out `validate-change`, `sol-loop`, babysitting and the merge; the reviewer owns those. Wherever `full-send` would ask the user, ask for help (below) instead.
6. Push `task/<n>` after your first commit and after each one that follows. The maestro reads pushes, comments and label changes as signs of life; a worker that shows none for an hour is flagged as stalled.

## Hand off

7. With the PR open, put the issue in the review queue:

   ```bash
   gh label create ready-for-review --force --color ededed >/dev/null
   gh issue edit <n> --add-label ready-for-review --remove-label in-progress
   ```

## Ask for help

When the issue lacks what you need, a rebase conflict touches logic you do not understand or would drop someone else's work, or you are stuck after a real attempt: push what you have, open the PR if there is one, and hand over. Write the comment body per `leaving-pr-comments`:

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Split the issue

When the issue is too big for one PR and you split it instead of building it, file the parts as sub-issues of `<n>` without `ready-for-agent`, link every blocked-by edge, and only then add `ready-for-agent` to each. A labelled part with its blocker not yet linked gets dispatched early. Then close `<n>`, or label it `needs-help` when the split itself needs a decision.

## Settle

Before your final message, settle every thread you started (research children, by their `childThreadId`) and then your own: `t3_thread_organize` with `action: "settle"`, the last call without `threadId`. Your part ends without a merge, so nothing else settles it.

## Final message

Exactly one line, nothing else:

- `#<n> pr <PR url>`
- `#<n> needs-help: <why>`
- `#<n> split into #<a>, #<b>, …`

If the maestro tells you the issue is still open, hand it off or ask for help, then end with that line again.
