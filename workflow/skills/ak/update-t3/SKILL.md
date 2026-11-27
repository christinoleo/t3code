---
name: update-t3
description: Update, rebuild, restart, pair or run Leo's T3 Code from source. Its full run updates the provider CLIs, merges upstream into the fork, and rebuilds and restarts T3 Code on every machine; it also covers a one-machine manual update, pairing a browser, and the isolated dev stack over Tailscale. Use when Leo asks to update, rebuild, restart, or run T3 Code / t3code, to pair a browser with it, or to start its dev server.
---

# T3 Code from source

Leo runs T3 Code from his clone at `~/Projects/T3/t3code` instead of the installed release. Reply to him in Portuguese.

The machines are every machine on Leo's tailnet that runs T3 Code from source. Find them on each run instead of keeping a list:

```sh
tailscale status --json | jq -r '.Peer[] | select(.Online and (.OS == "linux" or .OS == "windows")) | "\(.HostName) \(.OS)"'
```

A peer counts when `ssh -o BatchMode=yes -o ConnectTimeout=5 <host>` works and it has the checkout: `~/Projects/T3/t3code` on Linux, `%USERPROFILE%\Projects\T3\t3code` on Windows. Skip the rest silently; the tailnet also holds phones, work machines and dead nodes. This machine counts too. Check which one you are on with `hostname`, and on Linux read its own drop-in and `service.env` rather than assuming the values below. Windows machines have their own setup, described under [Windows machines](#windows-machines).

## Setup

- **Production service:** the systemd user unit `t3code.service` has the drop-in `~/.config/systemd/user/t3code.service.d/source.conf`. It runs `node apps/server/dist/bin.mjs serve --base-dir ~/.t3 --no-browser`, with `EnvironmentFile=~/.t3/service.env` (`T3CODE_HOST=127.0.0.1`, `T3CODE_PORT=3773`).
- **Real data:** `~/.t3/userdata`. The service log is `~/.t3/userdata/logs/boot-service.log`. Do not print it wholesale: it contains pairing QR codes and tokens.
- **Tailnet:** `tailscale serve` maps this machine's tailnet name (`tailscale serve status`) to `127.0.0.1:3773`.
- **Remotes:** origin is `christinoleo/t3code`, Leo's fork, where maestro workers merge. upstream is `pingdotgg/t3code`. Never push or open PRs upstream. Main is published, so upstream comes in by merge, never rebase.
- **The release's own updater is out of the loop.** `t3 update` and the release service launcher are not used. Never repoint the unit back at `~/.t3/runtime/versions/*`.
- **`vp` (Vite+) is not on PATH by default.** Prefix commands with `. ~/.config/vite-plus/env &&`.

## Update everything

When Leo asks to update T3, do this whole run on every machine without asking; each step says when to stop.

### 1. Check the checkout

On this machine, `~/Projects/T3/t3code` must be on `main` with no uncommitted changes (`git status --short --untracked-files=no`). If it has changes, stop and show them to Leo. Never stash or discard them.

### 2. Update the provider CLIs

Run [update-providers.sh](update-providers.sh) on every Linux machine at the same time (Windows machines update theirs in step 3):

```sh
cd ~/Projects/T3/t3code/workflow/skills/ak/update-t3
bash -l ./update-providers.sh
ssh <linux-host> 'bash -l -s' < update-providers.sh   # once per other Linux machine
```

The script picks the right updater for each machine. Mise-managed tools go through `mise upgrade`. Anything else uses its own updater (`claude update`, `grok update`, `opencode upgrade`). Running sessions keep their old binary until they restart. Report `FAILED:` lines, but carry on to step 3.

### 3. Update T3 Code, this machine last

`scripts/self-update.sh` does the git work, the build and the restart, the same as the app's Update / Rebuild button. It fast-forwards to origin/main, merges upstream/main, and pushes the merge. It then runs `vp i`, `vp run workflow:link`, builds, and restarts `t3code`. Run it through `systemd-run` so the restart can't kill it. Delete the old log first, or the wait can match the previous run's last line.

```sh
run='rm -f $HOME/.cache/t3code/source-update.log; systemd-run --user --unit t3code-source-update --collect --quiet --working-directory=$HOME/Projects/T3/t3code --setenv=T3CODE_SOURCE_UPDATE_SERVICE=t3code -p StandardOutput=truncate:$HOME/.cache/t3code/source-update.log $HOME/Projects/T3/t3code/scripts/self-update.sh'
ssh <host> "$run"
timeout 590 bash -c 'until ssh <host> "grep -E \"\[source-update\] (succeeded|failed)\" ~/.cache/t3code/source-update.log"; do sleep 10; done'
```

Start with one other Linux machine. It does the upstream merge and pushes it, so every machine after it only fast-forwards. Then the other Linux machines the same way, then the Windows machines (below), then this machine.

- **succeeded:** go on to the next machine.
- **failed, "does not merge cleanly":** merge on this machine instead (`git fetch upstream && git merge upstream/main`). Resolve the conflicts so both sides' intent survives, run `vp run check:changed`, commit, and push to origin. Then run that machine again.
- **failed, anything else:** show Leo the end of `~/.cache/t3code/source-update.log`; the service still runs the previous build. Stop there, or try [Update one machine by hand](#update-one-machine-by-hand) if the failure is in the script itself.

This machine goes last. Its restart can cut off the current turn, so send Leo the report first (step 4), with this machine's result still marked as pending. Then start the update:

```sh
eval "$run"
```

If the turn survives, wait on `~/.cache/t3code/source-update.log` the same way, then confirm every machine is on the same commit with `git log -1 --oneline`.

### 4. Report

- each provider's old version and new version, per machine;
- the commit each machine ended on, and whether upstream brought anything new;
- anything that failed.

### Windows machines

Windows machines (asuslaptop so far) run the server as the Scheduled Task "T3 Code", which starts `~\.t3\service.cmd` on `127.0.0.1:3773`. `self-update.sh`, `update-providers.sh` and the in-app Update button don't run there. [update-windows.ps1](update-windows.ps1) does the whole update on one: `claude update` and `mise upgrade`, then fast-forward to origin/main, `vp i`, skills, a build with vp's newest Node (the system Node can be too old), `~\.t3\restart.ps1`, and a wait for `/health`.

```sh
scp update-windows.ps1 <host>:update-t3.ps1
ssh <host> 'powershell -NoProfile -ExecutionPolicy Bypass -File update-t3.ps1'
```

The last line says `[windows-update] succeeded` or `failed` with the reason. On a failure the service keeps the previous build. Restart by hand with `powershell -File ~\.t3\restart.ps1` (`-Stop` stops it); `Stop-ScheduledTask` alone leaves node running.

## Update one machine by hand

The manual equivalent of step 3, for when `self-update.sh` itself is broken. Outside a full run Leo asked for, ask him before restarting if agent turns may be running: a restart interrupts them.

```sh
. ~/.config/vite-plus/env
cd ~/Projects/T3/t3code
git status --short          # commit or stash local work first
git pull origin main
git fetch upstream
git merge upstream/main
git push origin main
vp i                        # only needed when the lockfile changed, but cheap
vp run workflow:link        # re-links workflow/skills into each provider's skill folder
vp run --filter t3 build    # builds apps/web and bundles it into apps/server/dist
systemctl --user restart t3code
```

Then verify:

```sh
systemctl --user is-active t3code
grep -aE "Migrations ran|Listening on" ~/.t3/userdata/logs/boot-service.log | tail -3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3773/
```

A new version may migrate `~/.t3/userdata/statev2.sqlite`. Leo does not need a way back, but a cheap backup is a read-only `sqlite3 "file:$HOME/.t3/userdata/statev2.sqlite?mode=ro" ".backup '<dest>'"`.

## Pair a new browser with the service

```sh
node ~/Projects/T3/t3code/apps/server/dist/bin.mjs pair --base-dir ~/.t3 --tailscale --ttl 30m --label "<device>"
```

Give Leo the `Pairing URL` line. Do not open it yourself; a token is consumed on first use.

## Dev stack (hot reload, isolated data, over Tailscale)

`~/Projects/T3/t3code` is the main checkout, not a linked worktree. Because of that, plain `vp run dev` falls back to the REAL `~/.t3` and runs a second server on Leo's live database. Always pass `--home-dir`.

```sh
. ~/.config/vite-plus/env
cd ~/Projects/T3/t3code
# Refresh the isolated copy of real data (dev must be stopped). Reads ~/.t3 read-only.
vp run migrate-dev-db --base-dir /home/christinoleo/Projects/T3/t3code/.t3
# Start in the background from your own shell; stop it with the harness's task stop.
vp run dev --share --home-dir /home/christinoleo/Projects/T3/t3code/.t3
```

- Confirm the `[dev-runner]` line shows `baseDir=/home/christinoleo/Projects/T3/t3code/.t3`. If it shows `~/.t3`, stop the dev stack immediately.
- Wait for the `pairingUrl:` line and give that URL to Leo. The dev web port is 5733 and the server is on 13773, shared at port 5733 of this machine's tailnet name.
- UI changes in `apps/web` hot-reload in dev. They reach the service only after `vp run --filter t3 build` and `systemctl --user restart t3code`.
