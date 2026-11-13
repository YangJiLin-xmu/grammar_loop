param(
  [ValidateSet('install', 'dev', 'build', 'start', 'worker', 'test', 'typecheck', 'db:migrate', 'doctor')]
  [string]$Task = 'dev',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TaskArguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# Some host processes omit these Windows process variables. Node's crypto and
# Winsock need SystemRoot; repair only this process, never the machine settings.
$windowsDirectory = [Environment]::GetFolderPath('Windows')
if (-not $windowsDirectory) { $windowsDirectory = 'C:\Windows' }
if (-not $env:SystemRoot) { $env:SystemRoot = $windowsDirectory }
if (-not $env:WINDIR) { $env:WINDIR = $windowsDirectory }
if (-not $env:ComSpec) { $env:ComSpec = Join-Path $windowsDirectory 'System32\cmd.exe' }

# A regular Windows/Anaconda terminal does not inherit Codex's extra PATH.
# Locate a compatible executable explicitly, then pass its directory to every
# child process. Never change the user's or machine's persistent environment.
$minimumNode = [version]'22.13.0'
$nodeCandidates = @()
if ($env:GRAMMAR_LOOP_NODE) { $nodeCandidates += $env:GRAMMAR_LOOP_NODE }
$nodeCandidates += Join-Path $projectRoot '.tools\node\node.exe'
$nodeCandidates += @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$programFilesDirectory = if ($env:ProgramFiles) { $env:ProgramFiles } else { 'C:\Program Files' }
$nodeCandidates += Join-Path $programFilesDirectory 'nodejs\node.exe'
if ($env:LOCALAPPDATA) { $nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
$runtimePattern = Join-Path $programFilesDirectory 'WindowsApps\OpenAI.CodexPrimaryRuntime.*\dependencies\node\bin\node.exe'
$nodeCandidates += @(Get-ChildItem -Path $runtimePattern -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName })
# WindowsApps often permits exact file access while denying wildcard listing.
# Ask Windows for registered package locations rather than requiring that listing.
try {
  if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
    $runtimeLocations = @(Get-AppxPackage -Name '*CodexPrimaryRuntime*' | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation })
  } else {
    $systemPowerShell = Join-Path $windowsDirectory 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runtimeLocations = @(& $systemPowerShell -NoProfile -NonInteractive -Command 'Get-AppxPackage -Name "*CodexPrimaryRuntime*" | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }' 2>$null)
  }
  foreach ($location in $runtimeLocations) {
    if ($location -and (Test-Path -LiteralPath $location -PathType Container)) {
      $nodeCandidates += Join-Path $location 'dependencies\node\bin\node.exe'
    }
  }
} catch { }
$nodeBinary = $null
$nodeVersion = $null
foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    $versionText = & $candidate --version 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -ge $minimumNode) {
      $nodeBinary = $candidate
      $nodeVersion = $versionText
      break
    }
  } catch { continue }
}
if (-not $nodeBinary) {
  throw 'Compatible Node.js was not found. Install Node.js 24 LTS from https://nodejs.org, reopen the terminal, then run again. An existing node.exe can also be selected with GRAMMAR_LOOP_NODE. Minimum supported version: 22.13.0.'
}
$nodeDirectory = Split-Path -Parent $nodeBinary
$env:Path = "$nodeDirectory;$env:Path"

# Prefer the pinned project/runtime pnpm CLI, bypassing stale pnpm.cmd shims.
$runnerCandidates = @(
  (Join-Path $projectRoot '.tools\pnpm\bin\pnpm.mjs'),
  (Join-Path $nodeDirectory '..\node_modules\pnpm\bin\pnpm.mjs'),
  (Join-Path $nodeDirectory 'node_modules\pnpm\bin\pnpm.mjs')
)
$runnerPath = $runnerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
Push-Location $projectRoot
try {
  if ($Task -eq 'doctor') {
    Write-Host "Node.js: $nodeVersion"
    Write-Host "Executable: $nodeBinary"
    Write-Host "Project: $projectRoot"
    if ($runnerPath) {
      $managerVersion = & $nodeBinary $runnerPath --version
      if ($LASTEXITCODE -ne 0) { throw 'The selected pnpm CLI could not run.' }
      Write-Host "Package manager: pnpm $managerVersion"
    } elseif ((Test-Path -LiteralPath $npmCli) -or $npm) { Write-Host 'Package manager: npm' }
    else { throw 'No package manager found. Reinstall Node.js 24 LTS with npm enabled.' }
    Write-Host "Dependencies ready: $(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\next\dist\bin\next'))"
    Write-Host "Configuration file present: $(Test-Path -LiteralPath (Join-Path $projectRoot '.env.local'))"
    $taskExitCode = 0
  }
  elseif ($runnerPath) {
    if ($Task -eq 'install') { & $nodeBinary $runnerPath install @TaskArguments }
    else { & $nodeBinary $runnerPath run $Task @TaskArguments }
    $taskExitCode = $LASTEXITCODE
  }
  else {
    if (Test-Path -LiteralPath $npmCli) {
      if ($Task -eq 'install') { & $nodeBinary $npmCli install @TaskArguments }
      else { & $nodeBinary $npmCli run $Task -- @TaskArguments }
    } elseif ($npm) {
      if ($Task -eq 'install') { & $npm.Source install @TaskArguments }
      else { & $npm.Source run $Task -- @TaskArguments }
    } else { throw 'No package manager found. Reinstall Node.js 24 LTS with npm enabled.' }
    $taskExitCode = $LASTEXITCODE
  }
}
finally { Pop-Location }
exit $taskExitCode
