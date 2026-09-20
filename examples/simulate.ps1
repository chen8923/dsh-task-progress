<#
.SYNOPSIS
  Simulate a long-running task that reports structured progress.

.DESCRIPTION
  Proof that the producer side needs nothing but the environment variable: this
  script never talks to DSH, never knows the session id, and writes the same
  lines a build script or a training run would. Point it at
  $env:DSH_PROGRESS_DIR (set automatically inside DSH shell calls) or at any
  directory with -Dir.

.EXAMPLE
  ./examples/simulate.ps1 -Steps 30 -DelayMs 500
.EXAMPLE
  ./examples/simulate.ps1 -Task 'dataset-build' -Steps 10 -Dir ./progress
#>
param(
  # Task id, which is also the progress file's base name.
  [string]$Task = 'simulate',
  # How many steps to report.
  [int]$Steps = 20,
  # Delay between steps, milliseconds.
  [int]$DelayMs = 500,
  # Progress directory; defaults to $env:DSH_PROGRESS_DIR.
  [string]$Dir = $env:DSH_PROGRESS_DIR,
  # Fail at this step to exercise the failed state.
  [int]$FailAt = 0
)

$ErrorActionPreference = 'Stop'
if (-not $Dir) {
  throw 'no progress directory: run inside a DSH shell call, or pass -Dir <path>'
}
# The task id becomes a file name, so the reader's rule is this script's rule
# too: without it, -Task '..\..\x' would write outside the directory above.
if ($Task -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$') {
  throw "invalid -Task '$Task': use 1-40 of A-Z a-z 0-9 . _ -"
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$file = Join-Path $Dir "$Task.jsonl"

function Write-Progress-Line {
  param([hashtable]$Event)
  $Event['v'] = 1
  $Event['task'] = $Task
  $Event['at'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $json = $Event | ConvertTo-Json -Compress
  # UTF-8 without a BOM, and append-only: one line is one event.
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::AppendAllText($file, $json + "`n", $encoding)
  Write-Host ("[{0}] {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $Task, $json)
}

Write-Progress-Line @{ state = 'running'; pct = 0; msg = 'starting'; done = 0; total = $Steps; unit = 'steps' }
for ($step = 1; $step -le $Steps; $step++) {
  if ($FailAt -gt 0 -and $step -eq $FailAt) {
    Write-Progress-Line @{ state = 'failed'; msg = "step $step failed"; done = $step; total = $Steps; unit = 'steps' }
    exit 1
  }
  Start-Sleep -Milliseconds $DelayMs
  $pct = [Math]::Round(($step / $Steps) * 100)
  Write-Progress-Line @{ state = 'running'; pct = $pct; msg = "step $step of $Steps"; done = $step; total = $Steps; unit = 'steps' }
}
Write-Progress-Line @{ state = 'done'; pct = 100; msg = 'finished'; done = $Steps; total = $Steps; unit = 'steps' }
