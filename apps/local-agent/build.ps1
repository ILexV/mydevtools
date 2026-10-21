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

$PayloadName = "mydevtools-agent-windows-x64.exe"
$ArtifactExe = Join-Path $ArtifactDirectory $PayloadName
Copy-Item -LiteralPath $SourceExe -Destination $ArtifactExe -Force

$SetupName = "mydevtools-agent-windows-x64-setup.exe"
$SetupExe = Join-Path $ArtifactDirectory $SetupName
$NsisScript = Join-Path $PSScriptRoot "installer/mydevtools-agent.nsi"
$Icon = Join-Path $PSScriptRoot "assets/mydevtools.ico"
if (-not (Get-Command "makensis" -ErrorAction SilentlyContinue)) {
    throw "makensis is required to build the per-user Windows installer"
}
$Version = [string]$Package.version
$VersionMatch = [regex]::Match($Version, '^(\d+\.\d+\.\d+)')
if (-not $VersionMatch.Success) {
    throw "package version must start with major.minor.patch"
}
$VersionQuad = "$($VersionMatch.Groups[1].Value).0"
& makensis "-INPUTCHARSET" "UTF8" "-DPRODUCT_VERSION=$Version" "-DPRODUCT_VERSION_QUAD=$VersionQuad" "-DPAYLOAD=$SourceExe" "-DOUTFILE=$SetupExe" "-DICON=$Icon" $NsisScript
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }
if (-not (Test-Path -LiteralPath $SetupExe -PathType Leaf)) {
    throw "installer is missing: $SetupExe"
}

$DownloadSetup = Join-Path $DownloadDirectory $SetupName
$DownloadSetupTemporary = "$DownloadSetup.tmp"
Copy-Item -LiteralPath $SetupExe -Destination $DownloadSetupTemporary -Force
Move-Item -LiteralPath $DownloadSetupTemporary -Destination $DownloadSetup -Force
$OldPortableDownload = Join-Path $DownloadDirectory $PayloadName
if (Test-Path -LiteralPath $OldPortableDownload) {
    Remove-Item -LiteralPath $OldPortableDownload -Force
}

$Hash = (Get-FileHash -LiteralPath $DownloadSetup -Algorithm SHA256).Hash.ToLowerInvariant()
$Size = (Get-Item -LiteralPath $DownloadSetup).Length
$Release = [ordered]@{
    version = [string]$Package.version
    platform = "windows-x64"
    file = $SetupName
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

Write-Host "Windows agent installer: $DownloadSetup"
Write-Host "SHA-256: $Hash"
