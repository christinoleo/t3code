# Maestro model

A model of the issue lifecycle the `maestro`, `maestro-worker` and `maestro-reviewer` skills describe: a dispatcher and workers moving issues through `ready-for-agent`, `in-progress`, `ready-for-review`, `needs-help` and merged, with a blocked-by edge, worker deaths, stalled workers whose threads keep running, maestro restarts, and a master who may forget to nudge. A builder hands off and only a reviewer merges. Rerun it whenever either skill changes how an issue moves, and keep the model in step with the skill text.

TLC (exhaustive, shortest counterexamples). Java and the TLC jar come from mise; `statechart`'s first run installs them.

```sh
J=~/.local/share/mise/installs/java/temurin-25/bin/java
JAR=~/.local/share/mise/installs/http-tla2tools/1.7.4/tla2tools.jar
for c in Safe Gaps LiveRestart LiveSkipNudge; do $J -cp $JAR tlc2.TLC -metadir /tmp/maestro-tlc-$c -config $c.cfg Maestro.tla; done
```

- `Safe`: one worker per issue, and a blocked issue is never claimed (3 issues, 2 workers). Dropping `Holds(i) = {}` from `ClaimEn` breaks it: a review gets claimed while the builder that handed off is still ending.
- `Gaps`: a worker's `needs-help` is never lost across a maestro restart, and the heartbeat never sleeps while claimable work exists.
- `LiveRestart`, `LiveSkipNudge`: no silent stall, even with a restart or a master who skips the nudge. These run on 2 issues (B blocked by A): with review and stalls, 3 issues outgrow a 16 GB machine.

NetworkX (can every issue still reach merged from every state): `uv run --with networkx python check.py [--restart 1] [--skip-nudge]`. It writes `lifecycle-*.mmd`, and runs 2 issues for the same reason. Its state counts match TLC's `Live`, `LiveRestart` and `LiveSkipNudge`. The `norecheck` variant no longer fails: skipping an issue whose last thread still runs covers the stale claim the label re-check used to stop.

`statechart` draws the chart from `Gaps.cfg` with `view-gaps.mjs`: `~/.agents/skills/statechart/scripts/statechart Maestro.tla --config Gaps.cfg --view view-gaps.mjs --out <new dir>`.
