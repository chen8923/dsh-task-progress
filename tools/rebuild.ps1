<#
.SYNOPSIS
  Build this plugin, pack it, and install it into a DSH profile.

.DESCRIPTION
  DSH mounts a profile bundle at startup, so the last step is always "restart
  DSH". The profile references the packed tarball, which is why a source change
  needs bundle -> pack -> re-add rather than a file copy.

  Nothing here is machine-specific: put the toolchain on PATH, or point
  -Checkout at a DSH checkout that owns tsdown and the `dsh` CLI.

.EXAMPLE
  ./tools/rebuild.ps1 -Profile web
.EXAMPLE
  ./tools/rebuild.ps1 -Profile progress-dev -Checkout /path/to/deepseek-harness
#>
param(
  # Profile to install into. Use a scratch profile while developing.
  [string]$Profile = 'web',
  # DSH checkout that owns the toolchain (tsdown) and the `dsh` CLI.
  [string]$Checkout = $env:DSH_CHECKOUT,
  # Only produce the tarball; skip the install step.
  [switch]$PackOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Resolve-Tool {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Resolve-CheckoutTool {
  param([string]$Relative)
  if (-not $Checkout) { return $null }
  $path = Join-Path $Checkout $Relative
  if (Test-Path $path) { return $path }
  return $null
}

Write-Host '== bundling (tsdown) =='
$tsdown = Resolve-Tool 'tsdown'
if (-not $tsdown) { $tsdown = Resolve-CheckoutTool 'node_modules/.bin/tsdown.cmd' }
if (-not $tsdown) {
  throw 'tsdown not found: install it, or pass -Checkout <dsh checkout>'
}
Push-Location $root
try { & $tsdown } finally { Pop-Location }

$pnpm = Resolve-Tool 'pnpm'
$corepack = Resolve-Tool 'corepack'
if (-not $pnpm -and -not $corepack) { throw 'neither pnpm nor corepack is on PATH' }

function Invoke-Pnpm {
  param([string[]]$PnpmArgs)
  if ($pnpm) { & $pnpm @PnpmArgs } else { & $corepack 'pnpm' @PnpmArgs }
}

Write-Host '== packing =='
Push-Location $root
try { Invoke-Pnpm @('pack') } finally { Pop-Location }

$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$tarball = Join-Path $root ('{0}-{1}.tgz' -f $package.name, $package.version)
if (-not (Test-Path $tarball)) { throw "pack did not produce $tarball" }
if ($PackOnly) {
  Write-Host "Packed: $tarball"
  exit 0
}

Write-Host "== installing into profile '$Profile' =="
$spec = 'file:' + ($tarball -replace '\\', '/')
$dsh = Resolve-Tool 'dsh'
if ($dsh) {
  & $dsh plugin --profile $Profile add $spec
} elseif ($Checkout -and (Test-Path $Checkout)) {
  Push-Location $Checkout
  try { Invoke-Pnpm @('dsh', 'plugin', '--profile', $Profile, 'add', $spec) } finally { Pop-Location }
} else {
  throw "no dsh CLI on PATH and no valid -Checkout; install manually with: dsh plugin --profile $Profile add $spec"
}

Write-Host ''
Write-Host "Done. Restart DSH for profile '$Profile' to mount the new bundle."
