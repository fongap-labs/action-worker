# Centrally reviewed Windows build and portable runtime gate for Delta.
# The target provides source only. CI entrypoint and permissions belong to Action Worker.
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,
  [switch]$DeferReleasePrivacy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Measure each required trusted phase without printing commands or target paths.
function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $timeoutSeconds = switch ($script:stage) {
      'product-policy' { 120 }
      'release-build' { 3600 }
      'package-closure-regression' { 300 }
      'release-acceptance' { 900 }
      'release-privacy' { 900 }
      'release-archive-extraction' { 300 }
      default { throw 'Unrecognized Delta Windows CI command phase.' }
    }
    & node.exe (Join-Path $env:CENTRAL_CI_AW_ROOT 'scripts/delta-windows-phase.ts') $script:stage $timeoutSeconds $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      # Never echo a child process command line: it may contain credentials.
      throw "Delta Windows CI child process exited with code $LASTEXITCODE."
    }
  }
  finally {
    $watch.Stop()
    Write-Host ("Delta Windows CI timing stage={0} duration_ms={1}" -f $script:stage, $watch.ElapsedMilliseconds)
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

# The reviewed Delta suite alone selects its isolated pnpm 11 store.
# Other target repositories and their CI entrypoints are unaffected.
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'Missing trusted Windows Runner temporary directory.'
}
$env:pnpm_config_store_dir = Join-Path $env:RUNNER_TEMP 'delta-pnpm-store'

Push-Location -LiteralPath $root
$stage = 'toolchain-preflight'
Write-Host "Delta Windows CI start stage=$stage"
try {
  $version = (& node.exe -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or $version -cne '26.13.1') {
    throw 'Delta Windows CI requires Node 26.13.1.'
  }
  $pnpmVersion = (& pnpm.cmd --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.28.5') {
    throw 'Delta Windows CI requires pinned pnpm 11.28.5.'
  }

  $stage = 'product-policy'
  Write-Host "Delta Windows CI start stage=$stage"
  # Verify product policy without the CI-only pnpm child process path.
  # Frozen install and all builds are executed explicitly below via pnpm.cmd.
  Invoke-Checked 'node.exe' @('scripts/delta-verify.mjs')
  # CI must build exactly the same archive that the release worker builds.
  # No pre-built Electron output, alternate package command or reuse flags.
  $stage = 'release-build'
  Write-Host "Delta Windows CI start stage=$stage"
  $runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
  $releaseOutput = Join-Path $runnerTemp ("delta-release-ci-" + [guid]::NewGuid().ToString('N'))
  $portableOutput = Join-Path $releaseOutput 'extracted'
  New-Item -ItemType Directory -Force -Path $releaseOutput, $portableOutput | Out-Null
  $releaseVersion = '0.0.0-beta.1'
  Invoke-Checked 'pwsh.exe' @('-NoProfile', '-File', (Join-Path $root 'apps/desktop/scripts/build-delta-release.ps1'),
    '-Target', 'x86_64-pc-windows-msvc', '-Version', $releaseVersion, '-OutputDir', $releaseOutput)
  # Optional bounded numeric diagnostics, never a substitute for acceptance.
  try {
    & node.exe (Join-Path $env:CENTRAL_CI_AW_ROOT 'scripts/delta-package-timings.ts') $root 2>$null
  }
  catch { }
  $stage = 'package-closure-regression'
  Write-Host "Delta Windows CI start stage=$stage"
  Invoke-Checked 'pnpm.cmd' @('exec', 'vitest', 'run', 'apps/desktop/tests/prepare-package-set.spec.ts')
  $stage = 'release-acceptance'
  Write-Host "Delta Windows CI start stage=$stage"
  Invoke-Checked 'node.exe' @((Join-Path $root 'apps/desktop/scripts/verify-delta-release.mjs'),
    '--target', 'x86_64-pc-windows-msvc', '--version', $releaseVersion, '--output-dir', $releaseOutput)
  $stage = 'release-privacy'
  Write-Host "Delta Windows CI start stage=$stage"
  if ($DeferReleasePrivacy) {
    Write-Host 'Delta draft privacy scan deferred; not a complete CI verdict.'
  } else {
    Invoke-Checked 'python.exe' @((Join-Path $env:CENTRAL_CI_AW_ROOT 'scripts/artifact-privacy-scan.py'),
      $releaseOutput, (Join-Path $env:CENTRAL_CI_AW_ROOT 'policies/security.json'), '--diagnostics')
  }
  $stage = 'release-archive-extraction'
  Write-Host "Delta Windows CI start stage=$stage"
  $sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
  $archive = Join-Path $releaseOutput 'Delta-win-x64.zip'
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw 'Delta Windows CI did not produce a release archive.'
  }
  Invoke-Checked $sevenZip @('x', '-y', "-o$portableOutput", $archive)

  $stage = 'portable-output-layout'
  Write-Host "Delta Windows CI start stage=$stage"
  $children = @(Get-ChildItem -LiteralPath $portableOutput -Force | Select-Object -ExpandProperty Name | Sort-Object -CaseSensitive)
  if (($children -join ',') -cne 'App,Data,Other') {
    throw 'Delta portable output must contain exactly App, Data and Other directories.'
  }
  foreach ($relative in @(
    'App/Delta.exe', 'App/delta.cmd', 'App/resources/app.asar',
    'Data/UserData', 'Data/Session', 'Data/Logs', 'Data/Temp', 'Data/Home',
    'Other/README.md', 'Other/VERSION.json', 'Other/LICENSE',
    'Other/DEEPSEEK-HARNESS-MIT.txt', 'Other/THIRD_PARTY_NOTICES.md', 'Other/SHA256SUMS.txt'
  )) {
    $path = Join-Path $portableOutput ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $path)) { throw "Delta portable output is missing a required path: $relative" }
  }
  $versionRecord = Get-Content -Raw -LiteralPath (Join-Path $portableOutput 'Other/VERSION.json') | ConvertFrom-Json
  if ($versionRecord.product -cne 'Delta' -or $versionRecord.version -cne $releaseVersion -or $versionRecord.platform -cne 'win32-x64' -or
      $versionRecord.harnessSource -cne '4b399c39a6d1479cd84ca591b4d7c88e24d38a96') {
    throw 'Delta portable version record does not match the approved Windows x64 source.'
  }

  $stage = 'portable-checksum-verification'
  Write-Host "Delta Windows CI start stage=$stage"
  $sumPath = Join-Path $portableOutput 'Other/SHA256SUMS.txt'
  $sumLines = @(Get-Content -LiteralPath $sumPath)
  if ($sumLines.Count -lt 10) { throw 'Delta portable checksum manifest is unexpectedly small.' }
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($line in $sumLines) {
    if ($line -cnotmatch '^([0-9a-f]{64})  (App|Other)[\\/](.+)$') {
      throw 'Delta portable checksum manifest contains an invalid entry.'
    }
    $expected = $Matches[1]
    $relative = $Matches[2] + [System.IO.Path]::DirectorySeparatorChar + ($Matches[3] -replace '[\\/]', [System.IO.Path]::DirectorySeparatorChar)
    if (-not $seen.Add($relative)) { throw 'Delta portable checksum manifest contains a duplicate path.' }
    $path = [System.IO.Path]::GetFullPath((Join-Path $portableOutput $relative))
    $portablePrefix = $portableOutput.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($portablePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw 'Delta portable checksum entry escapes the package or names a missing file.'
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {
      throw 'Delta portable checksum verification failed.'
    }
  }
  if (-not $seen.Contains(('App' + [System.IO.Path]::DirectorySeparatorChar + 'Delta.exe')) -or
      -not $seen.Contains(('Other' + [System.IO.Path]::DirectorySeparatorChar + 'THIRD_PARTY_NOTICES.md'))) {
    throw 'Delta portable checksum manifest omits required product files.'
  }
  Write-Host 'Delta Windows CI unsigned build and App/Data/Other staging completed.'

  # Copy the packaged directory to prove it is not bound to its build path.
  # Redirect application data for the brief --version launch; do not inspect,
  # migrate, or delete the runner account's normal profile.
  $stage = 'portable-relocation'
  Write-Host "Delta Windows CI start stage=$stage"
  $runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
  $isolated = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'delta-windows-portable'))
  $runnerTempPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $isolated.StartsWith($runnerTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Delta Windows CI relocation path escaped the runner temporary directory.'
  }
  $relocated = Join-Path $isolated 'relocated'
  $appdata = Join-Path $isolated 'appdata'
  $localdata = Join-Path $isolated 'localdata'
  New-Item -ItemType Directory -Force -Path $relocated, $appdata, $localdata | Out-Null
  $relocationWatch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    Get-ChildItem -LiteralPath $portableOutput -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $relocated -Recurse -Force
    }
  }
  finally {
    $relocationWatch.Stop()
    Write-Host ("Delta Windows CI timing stage=portable-relocation duration_ms={0}" -f $relocationWatch.ElapsedMilliseconds)
  }
  $exe = Join-Path $relocated 'App/Delta.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Portable relocation lost Delta.exe.'
  }

  $priorAppData = $env:APPDATA
  $priorLocalData = $env:LOCALAPPDATA
  try {
    $env:APPDATA = $appdata
    $env:LOCALAPPDATA = $localdata
    $env:DELTA_PORTABLE_ROOT = $relocated
    $env:DSH_HOME = Join-Path $relocated 'Data/Home'
    $env:DSH_DESKTOP_USER_DATA_DIR = Join-Path $relocated 'Data/UserData'
    $stage = 'relocated-executable-startup'
    Write-Host "Delta Windows CI start stage=$stage"
    $startupWatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
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
      $startupWatch.Stop()
      Write-Host ("Delta Windows CI timing stage=relocated-executable-startup duration_ms={0}" -f $startupWatch.ElapsedMilliseconds)
    }
  }
  finally {
    $env:APPDATA = $priorAppData
    $env:LOCALAPPDATA = $priorLocalData
    Remove-Item Env:DELTA_PORTABLE_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:DSH_DESKTOP_USER_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $isolated -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'Delta Windows unsigned portable build and isolated runtime smoke passed.'
}
catch {
  # Fixed phase names only; logs must never disclose file paths, command arguments or credentials.
  Write-Host "Delta Windows CI failed at stage: $stage"
  throw
}
finally {
  Pop-Location
  if ((Get-Variable releaseOutput -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $releaseOutput)) {
    Remove-Item -LiteralPath $releaseOutput -Recurse -Force -ErrorAction SilentlyContinue
  }
}
