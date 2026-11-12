<#
.SYNOPSIS
  Windows wrapper for scripts/testnet-deploy/run-all (the POSIX shell script does the work).

.DESCRIPTION
  Runs run-all with Git for Windows' bash, passing every argument through. Set the same
  environment variables as for run-all (DOCKSIDE_ESCROW_ACCOUNT, DOCKSIDE_BUYER_ACCOUNT,
  DOCKSIDE_SUPPLIER_ACCOUNT, DOCKSIDE_RELAYER_ACCOUNT, optionally NEAR_CLI and CARGO).

.EXAMPLE
  $env:DOCKSIDE_ESCROW_ACCOUNT = "<escrow>.testnet"
  $env:DOCKSIDE_BUYER_ACCOUNT = "<buyer>.testnet"
  $env:DOCKSIDE_SUPPLIER_ACCOUNT = "<supplier>.testnet"
  $env:DOCKSIDE_RELAYER_ACCOUNT = "<relayer>.testnet"
  .\scripts\testnet-deploy\run-all.ps1 --network testnet
#>
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "run-all"
$candidates = @()
$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -ne $git) {
  # git.exe lives in <Git>\cmd or <Git>\bin; bash.exe in <Git>\bin.
  $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
  $candidates += (Join-Path $gitRoot "bin\bash.exe")
}
$candidates += "C:\Program Files\Git\bin\bash.exe"
$bash = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($null -eq $bash) {
  Write-Error "run-all.ps1 needs Git for Windows (bash.exe); install it or run scripts/testnet-deploy/run-all from a POSIX shell."
  exit 2
}
& $bash $script @args
exit $LASTEXITCODE
