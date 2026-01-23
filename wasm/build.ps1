[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [string[]]$Domains = @('hash', 'encoding', 'cryptography', 'structured_data', 'password', 'text_tools', 'image_tools', 'regex_tool')
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$siteWwwroot = Join-Path $repoRoot 'MyDevToolsApp\MyDevTools.Site\wwwroot'
$wasmOutRoot = Join-Path $siteWwwroot 'wasm'

if (-not (Test-Path $siteWwwroot)) {
    throw "Expected wwwroot at: $siteWwwroot"
}

function Get-CrateNameFromCargoToml {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CargoTomlPath
    )

    $content = Get-Content -Path $CargoTomlPath -Raw
    $inPackage = $false
    foreach ($line in ($content -split "`r?`n")) {
        $trim = $line.Trim()

        if ($trim -match '^\[package\]$') {
            $inPackage = $true
            continue
        }

        if ($inPackage -and $trim -match '^\[') {
            break
        }

        if ($inPackage -and $trim -match '^name\s*=\s*"([^"]+)"\s*$') {
            return $Matches[1]
        }
    }

    throw "Unable to determine crate name from: $CargoTomlPath"
}

$rustup = Get-Command 'rustup' -ErrorAction SilentlyContinue
if (-not $rustup) {
    throw 'rustup not found. Install Rust (rustup) first: https://www.rust-lang.org/tools/install'
}

$wasmBindgen = Get-Command 'wasm-bindgen' -ErrorAction SilentlyContinue
if (-not $wasmBindgen) {
    throw 'wasm-bindgen not found. Install it with: cargo install wasm-bindgen-cli --locked'
}

Write-Host 'Ensuring Rust target wasm32-unknown-unknown...' -ForegroundColor DarkGray
& $rustup.Source 'target' 'add' 'wasm32-unknown-unknown' | Out-Null

$cargoProfile = if ($Configuration -eq 'Release') { 'release' } else { 'debug' }

foreach ($domain in $Domains) {
    $crateDir = Join-Path $PSScriptRoot $domain
    $cargoToml = Join-Path $crateDir 'Cargo.toml'

    if (-not (Test-Path $crateDir)) {
        Write-Warning "Skip '$domain': folder not found ($crateDir)"
        continue
    }

    if (-not (Test-Path $cargoToml)) {
        Write-Host "Skip '$domain': no Cargo.toml yet" -ForegroundColor DarkGray
        continue
    }

    $outDir = Join-Path $wasmOutRoot $domain
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    Write-Host "Building WASM domain '$domain' → $outDir" -ForegroundColor Cyan

    $crateName = Get-CrateNameFromCargoToml -CargoTomlPath $cargoToml
    $workspaceRoot = $PSScriptRoot

    Push-Location $workspaceRoot
    try {
        $cargoArgs = @('build', '--target', 'wasm32-unknown-unknown', '-p', $crateName)
        if ($Configuration -eq 'Release') { $cargoArgs += '--release' }
        & cargo @cargoArgs

        $wasmInput = Join-Path $workspaceRoot ("target\wasm32-unknown-unknown\$cargoProfile\$crateName.wasm")
        if (-not (Test-Path $wasmInput)) {
            throw "Expected wasm artifact not found: $wasmInput"
        }

        & $wasmBindgen.Source $wasmInput --target web --out-dir $outDir --out-name $domain
    }
    finally {
        Pop-Location
    }
}

Write-Host 'Done.' -ForegroundColor Green
