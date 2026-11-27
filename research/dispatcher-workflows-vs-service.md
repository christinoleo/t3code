# Dispatcher: build on Workflows or a new server service?

Research for [#36](https://github.com/christinoleo/t3code/issues/36), part of the map [#35](https://github.com/christinoleo/t3code/issues/35).
All citations are paths in this repository at commit `c927431384`. The decision belongs to Leo; the last section is a recommendation, not a decision.

## Summary

Workflows (Labs) already does most of the hard work that `queue.sh` got wrong:

- runs that survive a restart and replay from a journal;
- a durable, server-wide worker pool;
- per-issue idempotency keys;
- agent steps whose liveness comes from thread run status;
- agent steps placed on linked machines;
- waits on pull requests;
- "Needs you" questions, on web, desktop and mobile.

Workflows lacks four things:

- a trigger for issue **changes**: it only reacts to new issues;
- tracker-visible **claims** and label or assignee edits;
- an automatic retry policy for **infrastructure deaths**: a server restart without continuation pauses the run until a person resumes it;
- **capacity-aware placement** across machines.

A new service would have to rebuild everything in the first list before it could start on the second. **The recommendation is to build the dispatcher on Workflows**: ship a built-in factory workflow, and fill the four gaps in the layers it already uses (`IssueService`, `WorkflowForge`, the triggers, and agent-step retry).

## The factory's needs, one by one

### 1. Reacting to issue state or label changes, not only new issues: **not covered (workaround exists)**

- `issues.opened` fires only for issues **created** after the trigger first looked. The first look only records the time (`apps/server/src/workflows/triggers.ts:160-173`, `apps/server/src/workflows/WorkflowEngine.ts:448-462`). The engine keeps only entries whose `createdAt` is at or after the watermark, then moves the watermark forward (`WorkflowEngine.ts:487-497`, `WorkflowEngine.ts:527`). A label added later, or a reopened issue, starts nothing.
- The engine polls once a minute and reads at most 100 items per look (`WorkflowEngine.ts:80-81`). The user doc says the same: "only items opened after the workflow first loads" (`docs/user/workflows.md:81`).
- **Workaround inside Workflows:** a poller workflow on `every("1 minute")` (`triggers.ts:55-63`; one minute is the shortest interval, `triggers.ts:58-61`). Its step calls `issues.list({ labels, state, assignee })` (`apps/server/src/workflows/forgeApi.ts:28-41`), then calls `start(taskWorkflow, issue, { key: issueUrl })` for each issue (`apps/server/src/workflows/stepServices.ts:438-457`). The same key always names the same run, so a repeat look starts nothing. This is polling, the same model `queue.sh` uses. Nothing in the engine is event-driven from the tracker.

### 2. A worker cap across projects: **covered on one server**

- `within("builders", { limit })` holds one place in a pool **shared by every run on the server**, with a first-come-first-served queue (`apps/server/src/workflows/workflow.ts:741-767`). The `concurrency` option on a workflow is a pool too (`workflow.ts:1108-1116`).
- Places are rows in SQLite (`workflow_pool_places`), so they survive restarts. A resumed run takes back all its places before queued requests do. A paused run is passed over and gives its place back (`apps/server/src/workflows/WorkflowStore.ts:583-660`).
- Tests prove both: "a run that pauses gives its place back, and once resumed queues for it again" (`apps/server/src/workflows/Workflows.test.ts:3762`) and "a pool is as big as the smallest limit asked for in it" (`Workflows.test.ts:3714`). Both pass at this commit.
- **Limit:** the pool counts places on the server that owns the run. A worker placed on a linked machine still takes its place from the origin server's pool. Nothing counts the linked machine's own load.

### 3. Claims that survive a restart: **partly covered**

- A run started with an idempotency key is one run per key. The key is stored, so it holds across retries, version bumps and restarts (`docs/user/workflows.md:60`, `stepServices.ts:438-457`, `WorkflowEngine.ts:503-510`). That works as a **local** claim: one server never starts two runs for the same issue.
- **No tracker-visible claim.** The forge surface that workflows see has `list`, `read`, `comment`, `setState` and `create`, and no label or assignee edit (`apps/server/src/workflows/WorkflowForge.ts:282-327`, `forgeApi.ts:28-51`). `IssueService.update` already supports labels and assignees where the tracker allows them (`apps/server/src/issue/IssueService.ts:721-740`). `WorkflowForge` just does not expose it.
- **No lease.** No expiry or owner marks a claim, so nothing tells a dead server's claim from a live one. Another server, or a human, cannot see the claim. The `queue.sh` failure "a foreign claim was never requeued" therefore stays open on this route too, unless a lease is added. `EffectOutbox` has lease columns (`apps/server/src/orchestration-v2/EffectOutbox.ts:195`, `:257`), but they are internal to orchestration and do not reach the tracker.

### 4. Liveness from thread run events: **covered**

- An agent step is an ordinary thread turn (`apps/server/src/workflows/WorkflowAgentThreads.ts:1`). The engine waits on that turn's run through `ThreadManagement.waitForThread` in 10-minute slices, so a lost event is asked about again (`WorkflowAgentThreads.ts:41-42`, `WorkflowAgentThreads.ts:237-298`).
- `waitForThread` follows the chain of restart continuations. A run that a restart cut and continued is not treated as ended while its continuation is pending (`apps/server/src/orchestration-v2/ThreadManagementService.ts:610-621`, `ThreadManagementService.ts:1143-1162`).
- The wait runs outside the run's journal. An engine that stops while an agent works is not blocked by that agent (`apps/server/src/workflows/workflowAgent.ts:289-329`).
- For linked machines, the same wait goes through the peer's `t3_thread_wait` and `t3_thread_read` (`apps/server/src/workflows/WorkflowAgentLinks.ts:258-290`).
- `MilestoneHub` (`apps/server/src/milestones/MilestoneHub.ts:45-80`) is an in-memory feed that keeps 1,000 events. Workflows does not use it, and does not need to.

### 5. Free retries after infrastructure deaths: **partly covered**

- A turn that ends `failed` (it **died**) is tried once more on a new thread. If it dies again, the run pauses and is **held for a person** (`workflowAgent.ts:376-380`, `workflowAgent.ts:442-446`, `workflowAgent.ts:466-476`). This is proven by the test "an agent whose turn dies is tried on a new thread, then its run pauses until resumed" (`Workflows.test.ts:1646`), which passes.
- A turn that ends `interrupted` or `cancelled` counts as **someone stopping it** and is not retried (`WorkflowAgentThreads.ts:296-297`; test at `Workflows.test.ts:2152`, which passes). Server restart recovery marks active runs `cancelled` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:685`).
  - When the project setting `continueThreadsAfterServerUpdate` is on (`ProviderRuntimeRecoveryService.ts:1128-1131`), a continuation run starts and the agent step follows it (section 4). Continuations stop after 3 in 5 minutes (`apps/server/src/orchestration-v2/RestartContinuation.ts:42-43`, `RestartContinuation.ts:292-312`).
  - Without a continuation, the step reads the restart as "stopped" and the run pauses. A restart therefore never uses up a retry, which is better than `queue.sh`. But the run waits for a manual resume, which is not "free".
- An unreachable linked machine is retried 5 times with exponential backoff (`WorkflowAgentLinks.ts:47-48`, `WorkflowAgentLinks.ts:70-73`). After that the wait is "lost" and the run pauses, without the hold. It then auto-resumes on the workflow's `resumeAfter` schedule (`workflowAgent.ts:330-339`, `workflow.ts:195-202`, `WorkflowEngine.ts:171-177`).
- `agent.try` returns the failure and its reason to the script instead of pausing. The workflow can then choose another model, another machine, or stop (`workflowAgent.ts:497-509`). A dispatcher can implement its own retry policy with it, but it would have to tell an infrastructure death from a job failure by parsing the reason text.

### 6. Separate builder and reviewer agents: **covered**

- Each `agent` step takes its own `model: { instanceId, model, options }`, which selects a provider instance, plus its own `project`, `environment`, `thread`, `workspace`, `runtimeMode` and `timeout` (`workflowAgent.ts:42-57`, `apps/server/src/workflows/WorkflowAgents.ts:23-35`). A builder step and a reviewer step on different providers are two calls.
- `pullRequests.wait(name, pr, { until: "checks" | "merged" | "closed" })` covers "wait for CI", and `pullRequests.act` covers merge (`forgeApi.ts:58-108`, `WorkflowForge.ts:66-127`).

### 7. Placing workers on linked machines: **covered as a mechanism, not as a policy**

- `agent(..., { environment })` starts the thread on a linked environment through that peer's T3 MCP tools: `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait` and `t3_thread_interrupt` (`WorkflowAgentLinks.ts:1`, `WorkflowAgentLinks.ts:196-330`).
- The **script** has to name the environment. Nothing chooses a machine by capacity or health. The run itself, with its journal and pools, lives only on the origin server: "Runs only advance while the server that started them is online" (`docs/user/workflows.md:90`).

## Constraints that apply to the Workflows route

- **Labs flag.** Nothing runs unless `workflowsEnabled` is on, and existing runs pause while it is off (`apps/server/src/workflows/WorkflowRuntime.ts:950-990`, `docs/user/workflows.md:9`).
- **Definitions come only from files.** The engine loads `.ts` files from `~/.t3/workflows` or `T3CODE_WORKFLOWS` and hot-reloads them (`WorkflowRuntime.ts:42`, `WorkflowRuntime.ts:564`, `WorkflowRuntime.ts:950-960`). No built-in definition path exists. To ship the factory as part of T3, the server must either install a definition file or gain a way to register built-in workflows.
- **Versioning.** Changing a step's shape needs a `version` bump, and the old version must stay defined while runs on it are open (`docs/user/workflows.md:41`).
- **Upstream churn.** 31 commits since 2026-09-01 touch `apps/server/src/workflows`. The fork merges `upstream/main` regularly, so every engine edit risks a conflict. A factory written as a workflow file plus small additions (new forge methods, a new trigger kind) touches the engine little.
- **The UI already exists.** Run lists, subjects that link runs to issues and PRs, "Needs you" questions (`ask` with `kind`), and run screens on web and mobile (`apps/mobile/src/features/workflows/`, `apps/mobile/src/Stack.tsx:142-143`, `docs/user/workflows.md:65-69`, `docs/user/workflows.md:83-87`). It is a generic run view, not a factory board.

## What a new service would reuse, and what it would rebuild

The existing services are small and generic:

- `Scheduler.register(name, effect)` is a 5-second tick with one permit per source (`apps/server/src/scheduling/Scheduler.ts:21-59`). Its users are scheduled tasks and usage-limit recovery (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:1422`, `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:154`).
- `PullRequestWatchReactor` wakes **threads** on PR changes. It exposes only `start` and `sweep` (`apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:237-243`).
- `MilestoneHub` publishes `thread.run_settled` and `needs_input` to subscribers, in memory (`MilestoneHub.ts:15-22`, `MilestoneHub.ts:45-80`).

A `Factory` service could build on these, but it would have to rebuild these parts of Workflows itself:

- a durable task table and journal;
- the pool and queue semantics;
- the agent start/watch/stop path for local and linked machines;
- the death and restart handling;
- PR waits;
- the questions behind "Needs you";
- run lists and UI on web, desktop and mobile;
- MCP and CLI control.

Its advantages are a state model built for the job, with explicit claim and lease states and typed contracts; no Labs gate; no definition files; and code that is mostly new, so fewer upstream conflicts.

## Cost of each route

|                                 | A. Build on Workflows                                                                               | B. New Effect service                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Durable runs, journal, restarts | Already built and tested                                                                            | Rebuild (new tables and migrations)                                                               |
| Worker cap (pool)               | Already built (`within`)                                                                            | Rebuild                                                                                           |
| Agent steps, local and linked   | Already built                                                                                       | Rebuild, or reuse `WorkflowAgentThreads` and `WorkflowAgentLinks`, which are shaped for workflows |
| PR wait and merge               | Already built                                                                                       | Rebuild, or reuse `PullRequestService` directly                                                   |
| Needs-you, run UI, mobile       | Already built (generic)                                                                             | New contracts plus UI on 3 surfaces plus i18n                                                     |
| Issue-change trigger            | Poller workflow (no engine change), or add an `issues.changed` trigger kind (small)                 | Build into the sweep                                                                              |
| Label/assignee edit, claim      | Expose `IssueService.update` in `WorkflowForge` (small); lease semantics are new in both routes     | Same `IssueService` work                                                                          |
| Infra-death retry               | Script policy via `agent.try`, or a typed failure kind on `Attempt` (small engine change)           | Build                                                                                             |
| Capacity-aware placement        | Script policy over `environment` and per-machine pool names                                         | Build                                                                                             |
| Shipping as built-in            | Install a definition, or add a built-in registry (small to medium); leave Labs, or require the flag | Not needed                                                                                        |
| Upstream conflict risk          | Medium if the engine is edited, low if the factory is a workflow file                               | Low (new files)                                                                                   |
| **Overall**                     | **Medium**: about four targeted additions plus the factory workflow                                 | **High**: a second durable orchestrator next to the first                                         |

## Recommendation (for Leo to decide)

**Route A: build the dispatcher on Workflows.** Ship the factory as a built-in workflow: a poller that starts one keyed run per issue, and a task workflow that runs build, PR wait, review and merge. Close the gaps in the layers underneath:

1. Add label and assignee edits to `WorkflowForge`. They come from `IssueService.update`. The MCP tools need the same edits (a gap the map already lists).
2. Add a tracker-visible claim and lease on top of those edits. Both routes need this, so it is not a cost of choosing Workflows.
3. Give agent failures a typed kind (infrastructure or job). Then `agent.try` can retry infrastructure deaths for free, and a restart without continuation does not wait for a person.
4. Add a way to ship a built-in workflow, and decide how it relates to the Labs flag.

**Main reason:** the failures behind this project were silent freezes, claims lost across restarts, and restarts that used up retries. Workflows' journaled runs, durable pools and thread-run liveness already fix the first two, and they are tested. A new service would write a second durable orchestrator next to the first before it could reach the parts that are actually missing: change triggers, tracker claims and placement policy.

**When route B wins instead:** if Leo wants the factory to work with Workflows switched off, or wants a first-class factory board instead of generic run lists, or does not want the factory's lifecycle written as a workflow script.
