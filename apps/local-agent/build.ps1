param(
    [ValidateSet("", "x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu")]
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Usage: pwsh -File apps/local-agent/build.ps1 [-Target x86_64-pc-windows-msvc|x86_64-pc-windows-gnu]
$IsWindowsHost = $env:OS -eq "Windows_NT"
if ([string]::IsNullOrWhiteSpace($Target)) {
    $Target = if ($IsWindowsHost) { "x86_64-pc-windows-msvc" } else { "x86_64-pc-windows-gnu" }
}
if ($Target -eq "x86_64-pc-windows-gnu" -and -not $IsWindowsHost) {
    if (-not (Get-Command "x86_64-w64-mingw32-gcc" -ErrorAction SilentlyContinue)) {
        throw "x86_64-w64-mingw32-gcc is required for the Windows GNU cross-build"
    }
}

$ManifestPath = Join-Path $PSScriptRoot "Cargo.toml"
& rustup target add $Target
if ($LASTEXITCODE -ne 0) { throw "rustup target add failed" }

$PreviousRustFlags = $env:RUSTFLAGS
try {
    if ($Target -eq "x86_64-pc-windows-msvc") {
        $env:RUSTFLAGS = ("$PreviousRustFlags -C target-feature=+crt-static").Trim()
    }
    & cargo build --locked --release --target $Target --manifest-path $ManifestPath
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
}
finally {
    if ($null -eq $PreviousRustFlags) {
        Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
    }
    else {
        $env:RUSTFLAGS = $PreviousRustFlags
    }
}

$MetadataJson = & cargo metadata --locked --no-deps --format-version 1 --manifest-path $ManifestPath
if ($LASTEXITCODE -ne 0) { throw "cargo metadata failed" }
$Metadata = $MetadataJson | ConvertFrom-Json
$Package = $Metadata.packages | Where-Object { $_.name -eq "mydevtools-local-agent" } | Select-Object -First 1
if ($null -eq $Package) { throw "package metadata is missing" }

$SourceExe = Join-Path $PSScriptRoot "target/$Target/release/mydevtools-local-agent.exe"
if (-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) {
    throw "built executable is missing: $SourceExe"
}

$ArtifactDirectory = Join-Path $PSScriptRoot "dist/windows-x64"
$DownloadDirectory = Join-Path $PSScriptRoot "../site/public/downloads"
New-Item -ItemType Directory -Force -Path $ArtifactDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null

$FileName = "mydevtools-agent-windows-x64.exe"
$ArtifactExe = Join-Path $ArtifactDirectory $FileName
$DownloadExe = Join-Path $DownloadDirectory $FileName
$DownloadExeTemporary = "$DownloadExe.tmp"
Copy-Item -LiteralPath $SourceExe -Destination $ArtifactExe -Force
Copy-Item -LiteralPath $SourceExe -Destination $DownloadExeTemporary -Force
Move-Item -LiteralPath $DownloadExeTemporary -Destination $DownloadExe -Force

$Hash = (Get-FileHash -LiteralPath $DownloadExe -Algorithm SHA256).Hash.ToLowerInvariant()
$Size = (Get-Item -LiteralPath $DownloadExe).Length
$Release = [ordered]@{
    version = [string]$Package.version
    platform = "windows-x64"
    file = $FileName
    sha256 = $Hash
    size = [long]$Size
}
$ReleaseJson = $Release | ConvertTo-Json -Compress
$ManifestFile = Join-Path $DownloadDirectory "local-agent.json"
$ManifestTemporary = "$ManifestFile.tmp"
[System.IO.File]::WriteAllText(
    $ManifestTemporary,
    $ReleaseJson,
    [System.Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $ManifestTemporary -Destination $ManifestFile -Force
[System.IO.File]::WriteAllText(
    (Join-Path $ArtifactDirectory "local-agent.json"),
    $ReleaseJson,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Windows agent: $DownloadExe"
Write-Host "SHA-256: $Hash"
