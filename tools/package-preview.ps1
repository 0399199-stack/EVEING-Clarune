[CmdletBinding()]
param(
    [ValidatePattern('^EVEINGClarune_(?:Preview(?:_[A-Za-z0-9-]+)?|ReleaseCandidate)$')]
    [string]$PreviewName = 'EVEINGClarune_Preview'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputsRoot = Split-Path -Parent $projectRoot
$workspaceRoot = Split-Path -Parent $outputsRoot
$previewRoot = [IO.Path]::GetFullPath((Join-Path $outputsRoot $PreviewName))
$toolRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'work/preview-packaging'))
$runtimeRoot = Join-Path $projectRoot 'node_modules/electron/dist'
$sourceExe = Join-Path $runtimeRoot 'electron.exe'
$previewExe = Join-Path $previewRoot 'EVEING Clarune.exe'
$iconPath = Join-Path $projectRoot 'resources/branding/clarune.ico'
$rceditPath = Join-Path $toolRoot 'rcedit-x64-v2.0.0.exe'
$rceditUrl = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe'
$rceditHash = '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A'

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    throw 'The preview packager requires Windows.'
}
if ((Split-Path -Parent $previewRoot) -ne $outputsRoot -or $previewRoot -eq $projectRoot) {
    throw 'The preview target must be a named EVEINGClarune_Preview sibling directory.'
}
foreach ($required in @($sourceExe, $iconPath, (Join-Path $projectRoot 'resources/realhat-worker.py'), (Join-Path $projectRoot 'out/main/index.js'), (Join-Path $projectRoot 'out/renderer/index.html'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing $required. Install dependencies and run pnpm build first."
    }
}
$runningPreview = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($previewExe, [StringComparison]::OrdinalIgnoreCase)
}
if ($runningPreview) {
    throw 'Close EVEING Clarune Preview before rebuilding it. No process has been terminated.'
}

New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
if (-not (Test-Path -LiteralPath $rceditPath -PathType Leaf)) {
    Invoke-WebRequest -Uri $rceditUrl -OutFile $rceditPath
}
if ((Get-FileHash -LiteralPath $rceditPath -Algorithm SHA256).Hash -ne $rceditHash) {
    throw 'The pinned rcedit binary failed its SHA-256 check.'
}
$sourceHashBefore = (Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path $previewRoot | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $runtimeRoot) {
    if ($item.Name -in @('electron.exe', 'resources')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $previewRoot -Recurse -Force
}
Copy-Item -LiteralPath $sourceExe -Destination $previewExe -Force

$previewResources = Join-Path $previewRoot 'resources'
$previewApp = Join-Path $previewResources 'app'
New-Item -ItemType Directory -Force -Path $previewApp | Out-Null
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $runtimeRoot 'resources')) {
    if ($item.Name -eq 'default_app.asar') { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $previewResources -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'out') -Destination $previewApp -Recurse -Force
$previewBrandParent = Join-Path $previewApp 'resources'
New-Item -ItemType Directory -Force -Path $previewBrandParent | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'resources/branding') -Destination $previewBrandParent -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'resources/realhat-worker.py') -Destination $previewResources -Force

# Copy the true runtime dependency closure (including Sharp's Windows native binary), never the development tree.
$previewModules = [IO.Path]::GetFullPath((Join-Path $previewApp 'node_modules'))
if ($previewModules -ne [IO.Path]::GetFullPath((Join-Path $previewRoot 'resources/app/node_modules'))) {
    throw 'Unexpected runtime dependency target.'
}
if (Test-Path -LiteralPath $previewModules) {
    if ((Get-Item -LiteralPath $previewModules).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The preview dependency target must not be a symbolic link or junction.'
    }
    Remove-Item -LiteralPath $previewModules -Recurse -Force
}
& node (Join-Path $projectRoot 'tools/export-production-deps.mjs') $previewModules $PreviewName
if ($LASTEXITCODE -ne 0) { throw 'Failed to export runtime dependencies.' }

$projectPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$previewPackage = [ordered]@{
    name = $projectPackage.name
    productName = 'EVEING Clarune'
    version = $projectPackage.version
    private = $true
    main = './out/main/index.js'
    description = 'EVEING Clarune local image studio preview'
    dependencies = $projectPackage.dependencies
    author = 'EVEING'
    license = 'UNLICENSED'
}
$packageJson = $previewPackage | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $previewApp 'package.json'), $packageJson, [Text.UTF8Encoding]::new($false))
$numericVersion = "$($projectPackage.version.Split('-')[0]).0"

& $rceditPath $previewExe --set-icon $iconPath `
    --set-version-string 'ProductName' 'EVEING Clarune' `
    --set-version-string 'FileDescription' 'EVEING Clarune' `
    --set-version-string 'CompanyName' 'EVEING' `
    --set-version-string 'LegalCopyright' 'Copyright 2026 EVEING. All rights reserved.' `
    --set-version-string 'OriginalFilename' 'EVEING Clarune.exe' `
    --set-version-string 'InternalName' 'EVEINGClarune' `
    --set-file-version $numericVersion --set-product-version $numericVersion
if ($LASTEXITCODE -ne 0) { throw "rcedit failed with exit code $LASTEXITCODE." }
if ((Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash -ne $sourceHashBefore) {
    throw 'The source Electron executable unexpectedly changed.'
}

# Read the icon back through Windows, so the check exercises the EXE resource.
Add-Type -AssemblyName System.Drawing
$extractedIcon = [Drawing.Icon]::ExtractAssociatedIcon($previewExe)
$expectedIcon = [Drawing.Icon]::new($iconPath, $extractedIcon.Width, $extractedIcon.Height)
$actualBitmap = $extractedIcon.ToBitmap()
$expectedBitmap = $expectedIcon.ToBitmap()
try {
    $matchingPixels = $actualBitmap.Width -eq $expectedBitmap.Width -and $actualBitmap.Height -eq $expectedBitmap.Height
    for ($x = 0; $matchingPixels -and $x -lt $actualBitmap.Width; $x++) {
        for ($y = 0; $y -lt $actualBitmap.Height; $y++) {
            if ($actualBitmap.GetPixel($x, $y).ToArgb() -ne $expectedBitmap.GetPixel($x, $y).ToArgb()) {
                $matchingPixels = $false
                break
            }
        }
    }
    if (-not $matchingPixels) { throw 'The icon extracted from the EXE differs from clarune.ico.' }
    $actualBitmap.Save((Join-Path $toolRoot 'preview-exe-icon.png'), [Drawing.Imaging.ImageFormat]::Png)
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($previewExe)
    if ($versionInfo.ProductName -ne 'EVEING Clarune' -or $versionInfo.CompanyName -ne 'EVEING') {
        throw 'The EXE branding metadata was not embedded correctly.'
    }
    $evidence = [ordered]@{
        generatedAt = [DateTime]::UtcNow.ToString('o')
        previewExe = $previewExe
        rceditSource = $rceditUrl
        rceditSha256 = $rceditHash
        sourceElectronUnchanged = $true
        exeSha256 = (Get-FileHash -LiteralPath $previewExe -Algorithm SHA256).Hash
        iconMatchesSource = $matchingPixels
        extractedIconSize = "$($actualBitmap.Width)x$($actualBitmap.Height)"
        productName = $versionInfo.ProductName
        companyName = $versionInfo.CompanyName
        fileVersion = $versionInfo.FileVersion
    }
    $evidenceJson = $evidence | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $toolRoot 'packaging-evidence.json'), $evidenceJson, [Text.UTF8Encoding]::new($false))
    $evidenceJson
}
finally {
    $actualBitmap.Dispose()
    $expectedBitmap.Dispose()
    $extractedIcon.Dispose()
    $expectedIcon.Dispose()
}
