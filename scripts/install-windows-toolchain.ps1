[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Install', 'Activate')]
    [string]$Mode = 'Plan',
    [string]$Root,
    [switch]$PersistPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FongapLabs\toolchain'
}
$Root = [IO.Path]::GetFullPath($Root)
if ($Root -match '[;\r\n"%!]' -or $Root -eq [IO.Path]::GetPathRoot($Root)) {
    throw 'Use a dedicated toolchain directory without shell metacharacters.'
}
if ($PersistPath -and $Mode -eq 'Plan') {
    throw 'Path persistence requires Install or Activate mode.'
}

$policy = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../policies/dependency-versions.json') -Raw | ConvertFrom-Json
if ($policy.schema_version -ne 1) { throw 'Invalid dependency catalog.' }

function Get-CatalogVersion([string]$Name, [string]$Pattern) {
    $entry = $policy.catalog.PSObject.Properties[$Name]
    if ($null -eq $entry -or $entry.Value.class -ne 'toolchain' -or
        $entry.Value.version -isnot [string] -or $entry.Value.version -notmatch $Pattern) {
        throw "Invalid central toolchain version: $Name"
    }
    return $entry.Value.version
}

$nodeVersion = Get-CatalogVersion 'tool:node' '^\d+\.\d+\.\d+$'
$pythonVersion = Get-CatalogVersion 'tool:python' '^\d+\.\d+(?:\.\d+)?$'
$pnpmVersion = Get-CatalogVersion 'tool:pnpm' '^\d+\.\d+\.\d+$'
$nodeDir = Join-Path $Root "node\$nodeVersion"
$pnpmDir = Join-Path $Root "pnpm\$pnpmVersion"
$pythonDir = Join-Path $Root "python\$pythonVersion"
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
$pnpmCmd = Join-Path $pnpmDir 'pnpm.cmd'

if ($Mode -eq 'Plan') {
    [ordered]@{
        mode = 'plan'
        root = $Root
        node = $nodeVersion
        pnpm = $pnpmVersion
        python = $pythonVersion
        node_directory = $nodeDir
        pnpm_directory = $pnpmDir
        python_directory = $pythonDir
        scope = 'current-user'
        python_components = @('interpreter', 'standard-library', 'pip', 'venv', 'development-headers')
        python_excluded = @('idle', 'tkinter', 'documentation', 'tests', 'debug-binaries', 'launcher', 'shortcuts')
        unpinned_tools = @('git', 'rust', 'uv')
        automatic_install = $false
    } | ConvertTo-Json -Depth 4
    return
}

if ($env:OS -ne 'Windows_NT') { throw 'Install and Activate require Windows.' }
$architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
switch ($architecture) {
    'AMD64' { $nodeArchitecture = 'x64' }
    'ARM64' { $nodeArchitecture = 'arm64' }
    default { throw 'Only Windows x64 and ARM64 are supported.' }
}

function Assert-ToolVersion([string]$Executable, [string]$Version) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "Missing managed executable: $Executable"
    }
    $actual = (& $Executable --version | Out-String).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or $actual -cne $Version) {
        throw "Managed tool version differs from the catalog: $Executable"
    }
}

function Install-Node {
    if (Test-Path -LiteralPath $nodeDir) {
        Assert-ToolVersion $nodeExe $nodeVersion
        return
    }
    $archiveName = "node-v$nodeVersion-win-$nodeArchitecture.zip"
    $baseUrl = "https://nodejs.org/dist/v$nodeVersion"
    $staging = Join-Path $Root ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        $archive = Join-Path $staging $archiveName
        $checksums = Join-Path $staging 'SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksums
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archive
        $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($archiveName) + '$'
        $checksumLines = @(Get-Content -LiteralPath $checksums | Where-Object { $_ -match $pattern })
        if ($checksumLines.Count -ne 1 -or $checksumLines[0] -notmatch $pattern) {
            throw 'Official Node archive checksum was not found.'
        }
        $expected = $Matches[1]
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) {
            throw 'Node archive checksum mismatch.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
        $extracted = Join-Path $staging "node-v$nodeVersion-win-$nodeArchitecture"
        Assert-ToolVersion (Join-Path $extracted 'node.exe') $nodeVersion
        New-Item -ItemType Directory -Path (Split-Path -Parent $nodeDir) -Force | Out-Null
        [IO.Directory]::Move($extracted, $nodeDir)
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

function Get-PythonPath([string]$Executable) {
    if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
        $Executable -match '\\WindowsApps\\') { return }
    try {
        $actual = (& $Executable -I -c 'import sys, pip, venv; print(sys.version.split()[0])' 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { return }
        if ($actual -ceq $pythonVersion -or
            ($pythonVersion.Split('.').Count -eq 2 -and $actual.StartsWith("$pythonVersion."))) {
            return $Executable
        }
    }
    catch { return }
}

function Find-Python {
    $candidate = Get-PythonPath (Join-Path $pythonDir 'python.exe')
    if ($candidate) { return $candidate }
    $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($launcher) {
        try {
            $series = ($pythonVersion.Split('.') | Select-Object -First 2) -join '.'
            $location = (& $launcher.Source "-$series" -I -c 'import sys; print(sys.executable)' 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0) {
                $candidate = Get-PythonPath $location
                if ($candidate) { return $candidate }
            }
        }
        catch { }
    }
    foreach ($command in @(Get-Command python.exe -All -CommandType Application -ErrorAction SilentlyContinue)) {
        $candidate = Get-PythonPath $command.Source
        if ($candidate) { return $candidate }
    }
}

function Install-Python {
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) { throw 'Python is missing and Windows Package Manager is not available.' }
    if (Test-Path -LiteralPath $pythonDir) {
        throw 'Existing managed Python is incomplete; inspect it before retrying.'
    }
    $series = ($pythonVersion.Split('.') | Select-Object -First 2) -join '.'
    $override = '/quiet InstallAllUsers=0 Include_launcher=0 InstallLauncherAllUsers=0 ' +
        'AssociateFiles=0 Shortcuts=0 PrependPath=0 Include_doc=0 Include_test=0 ' +
        'Include_tcltk=0 Include_pip=1 Include_lib=1 Include_exe=1 Include_dev=1 ' +
        'Include_symbols=0 Include_debug=0 CompileAll=0 TargetDir="' + $pythonDir + '"'
    $arguments = 'install --id Python.Python.' + $series + ' --exact --scope user --source winget --silent'
    if ($pythonVersion.Split('.').Count -eq 3) { $arguments += " --version $pythonVersion" }
    $arguments += ' --override "' + $override.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) { throw "Python installation failed ($($process.ExitCode))." }
    $candidate = Get-PythonPath (Join-Path $pythonDir 'python.exe')
    if (-not $candidate) { throw 'Installed Python failed version or component verification.' }
    return $candidate
}

function Join-ToolPath([string[]]$Directories, [string]$Existing) {
    $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $ordered = foreach ($entry in @($Directories) + @($Existing -split ';')) {
        if ($entry -and $unique.Add($entry.TrimEnd('\'))) { $entry }
    }
    return ($ordered -join ';')
}

$previousPath = $env:Path
$previousPmPolicy = $env:npm_config_pm_on_fail
try {
    if ($Mode -eq 'Install') {
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        Install-Node
    }
    Assert-ToolVersion $nodeExe $nodeVersion
    $env:Path = Join-ToolPath @($nodeDir) $previousPath
    $env:npm_config_pm_on_fail = 'error'
    if ($Mode -eq 'Install' -and -not (Test-Path -LiteralPath $pnpmDir)) {
        $staging = Join-Path $Root ([Guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $staging | Out-Null
        try {
            Push-Location -LiteralPath $staging
            try {
                & $npmCmd install --global --prefix $staging --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org "pnpm@$pnpmVersion"
                if ($LASTEXITCODE -ne 0) { throw 'Pinned pnpm installation failed.' }
                Assert-ToolVersion (Join-Path $staging 'pnpm.cmd') $pnpmVersion
            }
            finally { Pop-Location }
            New-Item -ItemType Directory -Path (Split-Path -Parent $pnpmDir) -Force | Out-Null
            [IO.Directory]::Move($staging, $pnpmDir)
        }
        finally {
            if (Test-Path -LiteralPath $staging) {
                Remove-Item -LiteralPath $staging -Recurse -Force
            }
        }
    }
    Push-Location -LiteralPath $Root
    try { Assert-ToolVersion $pnpmCmd $pnpmVersion }
    finally { Pop-Location }
    $pythonExe = Find-Python
    if (-not $pythonExe -and $Mode -eq 'Install') { $pythonExe = Install-Python }
    if (-not $pythonExe) { throw 'No compatible Python with pip and venv was found.' }
    $pythonHome = Split-Path -Parent $pythonExe
    $directories = @($nodeDir, $pnpmDir, $pythonHome, (Join-Path $pythonHome 'Scripts'))
    $env:Path = Join-ToolPath $directories $previousPath
    if ($PersistPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        [Environment]::SetEnvironmentVariable('Path', (Join-ToolPath $directories $userPath), 'User')
        [Environment]::SetEnvironmentVariable('npm_config_pm_on_fail', 'error', 'User')
    }
    Write-Host "Shared toolchain ready: $Root"
    Write-Host "Node $nodeVersion; pnpm $pnpmVersion; Python $pythonVersion series."
    Write-Host "Launch agents from this shell to inherit the managed PATH."
    if ($PersistPath) {
        Write-Host 'Restart desktop agents; machine PATH entries may still take precedence.'
    }
    if (-not (Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        Write-Warning 'Git is not installed or not on PATH; no unpinned tools were installed.'
    }
}
catch {
    $env:Path = $previousPath
    $env:npm_config_pm_on_fail = $previousPmPolicy
    throw
}
