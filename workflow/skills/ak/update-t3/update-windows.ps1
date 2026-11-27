# Updates a Windows machine's T3 Code from source (the Windows half of SKILL.md step 3). Run from omarchy
# after distilo succeeded, so origin/main already holds the upstream merge:
#   scp update-windows.ps1 <host>:update-t3.ps1
#   ssh <host> 'powershell -NoProfile -ExecutionPolicy Bypass -File update-t3.ps1'
# Updates claude and mise tools, fast-forwards to origin/main, installs, builds with vp's newest Node (the
# system Node may be too old for the build), relinks skills, restarts via ~\.t3\restart.ps1 and waits for
# /health. The last line is "[windows-update] succeeded|failed: ...".
# Native tools write warnings to stderr; 'Continue' keeps PowerShell from treating those as fatal.
$ErrorActionPreference = 'Continue'
function Done($ok, $msg) { Write-Output "[windows-update] $(if ($ok) {'succeeded'} else {'failed'}): $msg"; exit ([int](-not $ok)) }
try {
  foreach ($cmd in @('claude update', 'mise upgrade')) {
    try { Invoke-Expression $cmd *> $null; if ($LASTEXITCODE) { Write-Output "FAILED: $cmd" } } catch { Write-Output "FAILED: $cmd" }
  }
  . "$env:APPDATA\vite-plus\env.ps1" -ErrorAction Stop
  $node = Get-ChildItem "$env:LOCALAPPDATA\vite-plus\data\js_runtime\node" -Directory |
    Sort-Object { [version]$_.Name } | Select-Object -Last 1
  if ($node) { $env:PATH = "$($node.FullName);$env:PATH" }
  Set-Location "$env:USERPROFILE\Projects\T3\t3code" -ErrorAction Stop
  if (git status --short --untracked-files=no) { Done $false 'checkout has uncommitted changes; not touching it' }
  git fetch --quiet origin
  git merge --ff-only --quiet origin/main
  if ($LASTEXITCODE) { Done $false 'main does not fast-forward to origin/main' }
  vp i *> $null;                       if ($LASTEXITCODE) { Done $false 'vp i failed' }
  vp run workflow:link *> $null;       if ($LASTEXITCODE) { Done $false 'workflow:link failed' }
  vp run --filter t3 build *> $null;   if ($LASTEXITCODE) { Done $false 'build failed; the service still runs the previous build' }
  & "$env:USERPROFILE\.t3\restart.ps1" *> $null
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:3773/health).StatusCode -eq 200) { Done $true (git log -1 --oneline) } } catch {}
  }
  Done $false 'server did not answer /health within 60s; see ~\.t3\userdata\logs\service-stdout.log'
} catch { Done $false $_.Exception.Message }
