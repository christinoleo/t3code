---
name: maestro-reviewer
description: Review, fix and merge one maestro worker's PR as a different agent from the one that built it. Runs validate-change and sol-loop, posts the maestro/verify status, checks main right before merging, and merges. Use when a task says to use the maestro-reviewer skill for an issue.
---

You are a maestro reviewer. Your task names the issue `<n>` and the repo. Another agent built the PR on `task/<n>`. You did not write it, so do not trust its claims: read the code and run it. You own it from here to the merge. You already run in an isolated checkout prepared for you.

## Pick up

1. `gh issue view <n>` and `gh pr view task/<n> --json number,url,state,baseRefName,headRefOid`. With no open PR, ask for help (below).
2. `git fetch origin && git checkout -B task/<n> origin/task/<n>`.
3. If `.t3/setup-done` is missing and `.t3/setup-running` names no live PID, run the repo's install step.

## Review

4. Run `validate-change` on the diff against the PR's base. Its Review step runs `diff-review`'s Spec axis against the issue.
5. Run `sol-loop` on the PR, with one override: its reviewer runs on your own provider and model, not GPT Sol.
6. Fix what both find, inside the issue's scope. Commit and push `task/<n>` after each round; the maestro reads pushes as signs of life.
7. Wait for CI and review bots with `~/.agents/skills/babysit-pr/scripts/pr-wait`, as `babysit-pr` describes. Never call `watch_pull_request`. Fix real findings, then go back to step 4 for what the fix touched.

## Verify

8. When steps 4 to 7 leave nothing open, post the status on the head you reviewed:

   ```bash
   gh api repos/{owner}/{repo}/statuses/$(git rev-parse HEAD) -f state=success \
     -f context=maestro/verify -f description="validate-change and sol-loop passed"
   ```

   A status belongs to one commit, so every later push needs a new one. When you cannot get there, post `state=failure` with a one-line reason and ask for help.

## Merge

9. **Check main first.** `git fetch origin`, then compare what main gained since the PR's merge base with what the PR touches:

   ```bash
   base=$(git merge-base HEAD origin/<base>)
   git diff --name-only "$base" origin/<base>   # what main changed
   git diff --name-only "$base" HEAD            # what the PR changed
   ```

   Rebase onto `origin/<base>` and push with `--force-with-lease` when the lists share a file, when main changed something the PR calls or depends on (an import, a dependency version, the lockfile), or when main changed CI config. After the rebase, rerun `validate-change`'s checks step, wait for CI, and post `maestro/verify` again on the new head. Otherwise leave the branch as it is. When main forces a third rebase, ask for help instead.
10. Merge when `full-send`'s merge gate holds and `maestro/verify` is `success` on the current head:

    ```bash
    gh api repos/{owner}/{repo}/commits/$(git rev-parse HEAD)/status \
      --jq '.statuses[] | select(.context == "maestro/verify") | .state'
    ```

    Merge with the method the repo uses, as `full-send` says. The merge closes the issue.

## Ask for help

Do not merge when the change adds or edits a database migration, when a rebase conflict touches logic you do not understand or would drop someone else's work, or when you are stuck after a real attempt. Push what you have and hand over. Write the comment body per `leaving-pr-comments`:

```bash
gh issue edit <n> --add-label needs-help
gh issue comment <n> --body "<what needs a decision, and what you would do>"
```

## Settle

Before your final message, settle every thread you started (review and research children, by their `childThreadId`) with `t3_thread_organize` and `action: "settle"`. When you end without a merge, settle your own thread too: the same call without `threadId`. A merged PR settles it already.

## Final message

Exactly one line, nothing else:

- `#<n> merged <PR url>`
- `#<n> needs-help: <why>`

If the maestro tells you the issue is still open, finish it or ask for help, then end with that line again.
