# Centrally reviewed Windows build and portable runtime gate for Delta.
# The target provides source only. CI entrypoint and permissions belong to Action Worker.
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Delta Windows CI command failed ($LASTEXITCODE): $Command $($Arguments[0])"
  }
}

$root = [System.IO.Path]::GetFullPath($TargetRoot)
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
  throw 'Delta Windows CI requires a pinned, checked-out source root.'
}
if ($env:CI -ne 'true') {
  throw 'Delta Windows CI must run in a trusted CI runner.'
}
if ($env:CENTRAL_CI_AW_ROOT -eq $null -or -not (Test-Path -LiteralPath $env:CENTRAL_CI_AW_ROOT)) {
  throw 'Missing trusted Action Worker root.'
}
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT -or
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
      [System.Runtime.InteropServices.Architecture]::X64) {
  throw 'Delta Windows CI requires a native Windows x64 host.'
}

Push-Location -LiteralPath $root
try {
  $version = (& node.exe -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^24\.9\.') {
    throw "Delta Windows CI requires Node 24.9.x."
  }
  $pnpmVersion = (& pnpm.cmd --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.28.5') {
    throw 'Delta Windows CI requires pinned pnpm 11.28.5.'
  }

  # Verify product policy without the CI-only pnpm child process path.
  # Frozen install and all builds are executed explicitly below via pnpm.cmd.
  Invoke-Checked 'node.exe' @('scripts/delta-verify.mjs')
  Invoke-Checked 'pnpm.cmd' @('install', '--frozen-lockfile')
  Invoke-Checked 'pnpm.cmd' @('run', 'build:lib:host')
  Invoke-Checked 'pnpm.cmd' @('--filter', '@fongap-labs/delta-plugin-shared', 'run', 'build')
  Invoke-Checked 'pnpm.cmd' @('--filter', '@fongap-labs/delta-code', 'run', 'build')
  Invoke-Checked 'pnpm.cmd' @('run', 'build:desktop')

  # This documented offline preset is unsigned: it does not load signing or
  # update credentials. The package command itself runs its packaged Electron
  # runtime smoke on Windows, including Host startup and runtime payload checks.
  $env:DELTA_PORTABLE_OFFLINE = '1'
  Invoke-Checked 'pnpm.cmd' @('run', 'package:desktop:win:x64:dir')
  $unpacked = Join-Path $root 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked'
  $binary = Join-Path $unpacked 'Delta.exe'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or
      (Get-Item -LiteralPath $binary).Length -le 0) {
    throw 'Delta Windows CI did not produce an executable portable directory.'
  }

  # Copy the packaged directory to prove it is not bound to its build path.
  # Redirect application data for the brief --version launch; do not inspect,
  # migrate, or delete the runner account's normal profile.
  $isolated = Join-Path $env:RUNNER_TEMP 'delta-windows-portable'
  $relocated = Join-Path $isolated 'relocated'
  $appdata = Join-Path $isolated 'appdata'
  $localdata = Join-Path $isolated 'localdata'
  New-Item -ItemType Directory -Force -Path $appdata, $localdata | Out-Null
  Copy-Item -LiteralPath $unpacked -Destination $relocated -Recurse -Force
  $exe = Join-Path $relocated 'Delta.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Portable relocation lost Delta.exe.'
  }

  $priorAppData = $env:APPDATA
  $priorLocalData = $env:LOCALAPPDATA
  try {
    $env:APPDATA = $appdata
    $env:LOCALAPPDATA = $localdata
    $process = Start-Process -FilePath $exe -ArgumentList '--version' -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(30000)) {
      $process.Kill()
      throw 'Relocated Delta.exe did not exit its version smoke within 30 seconds.'
    }
    if ($process.ExitCode -ne 0) {
      throw "Relocated Delta.exe failed its startup probe (exit $($process.ExitCode))."
    }
  }
  finally {
    $env:APPDATA = $priorAppData
    $env:LOCALAPPDATA = $priorLocalData
    Remove-Item -LiteralPath $isolated -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'Delta Windows unsigned portable build and isolated runtime smoke passed.'
}
finally {
  Pop-Location
}
