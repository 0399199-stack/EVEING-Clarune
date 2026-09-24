[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublicKeyPem,
    [ValidatePattern('^fix[1-9][0-9]*$')]
    [string]$InstallerRevision = 'fix1',
    [switch]$CompileOnly,
    [switch]$TestOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputsRoot = Split-Path -Parent $projectRoot
$workspaceRoot = Split-Path -Parent $outputsRoot
$stageRoot = [IO.Path]::GetFullPath((Join-Path $outputsRoot 'EVEINGClarune_ReleaseCandidate'))
$installerRoot = if ($TestOnly) { [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'work/release-installer-test')) } else { [IO.Path]::GetFullPath((Join-Path $outputsRoot 'EVEINGClarune_Installer')) }
$compiler = Join-Path $workspaceRoot 'work/installer-tools/inno7-extracted/{app}/ISCC.exe'
$chineseMessages = Join-Path $workspaceRoot 'work/installer-tools/inno7-extracted/{app}/Languages/ChineseSimplified.isl'
$definition = Join-Path $PSScriptRoot 'installer/clarune.iss'
$vcRedist = Join-Path $stageRoot 'Prerequisites/vc_redist.x64.exe'
$vcLicense = Join-Path $stageRoot 'Prerequisites/Microsoft-VC-v14-License.docx'
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -ne '1.0.0-rc.1') { throw 'This installer pipeline is limited to the reviewed 1.0.0-rc.1 release candidate.' }
$installerName = if ($TestOnly) { "TEST-ONLY-EVEING-Clarune-$($package.version)-Full-x64-Setup-$InstallerRevision" } else { "EVEING-Clarune-$($package.version)-Full-x64-Setup-$InstallerRevision" }
$installerBuildNumber = [int]$InstallerRevision.Substring(3) + 1
$installerFile = Join-Path $installerRoot "$installerName.exe"
$installerAppId = if ($TestOnly) { 'com.eveing.clarune.installer-test' } else { 'com.eveing.clarune.desktop' }
$directoryName = if ($TestOnly) { 'EVEING Clarune TEST-ONLY' } else { 'EVEING Clarune' }
$checkedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Assert-NoLinks([string]$Path) {
    $existing = [IO.Path]::GetFullPath($Path)
    while (-not (Test-Path -LiteralPath $existing)) {
        $parent = Split-Path -Parent $existing
        if (-not $parent -or $parent -eq $existing) { throw "Cannot resolve target parent: $Path" }
        $existing = $parent
    }
    $item = Get-Item -LiteralPath $existing -Force
    while ($item) {
        if ($checkedPaths.Contains($item.FullName)) { break }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked release paths are not allowed: $($item.FullName)" }
        [void]$checkedPaths.Add($item.FullName)
        $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
}
function Required-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required release file is missing: $Path" }
    Assert-NoLinks $Path
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Utf8([string]$Path, [string]$Content) { [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false)) }

if ((Split-Path -Parent $stageRoot) -ne $outputsRoot) { throw 'Release stage must stay within its dedicated output folder.' }
Assert-NoLinks $stageRoot
Assert-NoLinks $installerRoot
foreach ($relative in @('resources', 'resources/app', 'resources/app/node_modules', 'resources/license-public-key.pem', 'clarune-installation.ini', 'RELEASE_CANDIDATE_NOTICE.txt', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'docs/INSTALLATION.md', 'Prerequisites/README.txt')) {
    Assert-NoLinks (Join-Path $stageRoot $relative)
}
Required-File $compiler
Required-File $chineseMessages
Required-File $definition
if ((Hash $compiler) -ne 'd06ebd38f38e3cee60a3c50cc45bd449d77e0bc6a5cabc607ea9886808e4de1a') { throw 'The reviewed Inno Setup 7.1.0 compiler has changed.' }
if ((Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid') { throw 'The Inno compiler signature is not valid. This does not sign the resulting Clarune installer.' }
if (Test-Path -LiteralPath $installerFile) { throw "Refusing to overwrite an existing installer: $installerFile" }

$publicKeyPath = (Resolve-Path -LiteralPath $PublicKeyPem).Path
Required-File $publicKeyPath
if ($TestOnly -and [IO.Path]::GetFileName($publicKeyPath) -notmatch '(?i)TEST-ONLY') { throw 'TestOnly requires a public-key filename explicitly containing TEST-ONLY.' }
if (-not $TestOnly -and [IO.Path]::GetFileName($publicKeyPath) -match '(?i)TEST-ONLY') { throw 'A TEST-ONLY public key must not enter a normal candidate installer.' }
if ((Get-Item -LiteralPath $publicKeyPath).Length -gt 8192) { throw 'Public key file is too large.' }
$node = (Get-Command node -ErrorAction Stop).Source
$keyCheck = @'
const fs = require('node:fs');
const crypto = require('node:crypto');
const text = fs.readFileSync(process.argv[1], 'utf8').trim();
if (!text.startsWith('-----BEGIN PUBLIC KEY-----') || text.includes('PRIVATE KEY')) throw new Error('Only an SPKI public key is accepted');
const key = crypto.createPublicKey(text);
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 public key is required');
process.stdout.write(JSON.stringify({ pem: key.export({type:'spki',format:'pem'}), fingerprint: crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex') }));
'@
$keyJson = & $node -e $keyCheck $publicKeyPath
if ($LASTEXITCODE -ne 0) { throw 'Release public key verification failed. Private keys are never accepted.' }
$key = $keyJson | ConvertFrom-Json
if ($key.fingerprint -notmatch '^[a-f0-9]{64}$') { throw 'Invalid public-key fingerprint result.' }

$stageExe = Join-Path $stageRoot 'EVEING Clarune.exe'
if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($stageExe, [StringComparison]::OrdinalIgnoreCase) }) {
    throw 'Close the ReleaseCandidate application before packaging. No process has been closed.'
}
if (-not $CompileOnly) {
    # Copies the already-built app only. Existing resources/ai is not deleted or modified.
    & (Join-Path $PSScriptRoot 'package-preview.ps1') -PreviewName 'EVEINGClarune_ReleaseCandidate'
    if (-not $?) { throw 'Application staging failed.' }
}
Required-File $stageExe
Required-File (Join-Path $stageRoot 'resources/app/out/main/index.js')
Required-File (Join-Path $stageRoot 'resources/app/out/renderer/index.html')
Required-File (Join-Path $stageRoot 'resources/realhat-worker.py')
Required-File $vcRedist
Required-File $vcLicense
if ((Hash $vcLicense) -ne '08651651a7602fc7c0e2763de0fde1ff9f868df2780597cd1775ee9d6441c783') { throw 'The unmodified Microsoft VC v14 license document is missing or changed.' }
$vcSignature = Get-AuthenticodeSignature -LiteralPath $vcRedist
if ($vcSignature.Status -ne 'Valid' -or $vcSignature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') { throw 'The bundled VC++ x64 redistributable must have a valid Microsoft Corporation signature.' }
$vcVersion = (Get-Item -LiteralPath $vcRedist).VersionInfo
if ($vcVersion.FileMajorPart -ne 14 -or $vcVersion.FileBuildPart -lt 1) { throw 'Unexpected VC++ 14.x redistributable version metadata.' }
$stagedPackage = Get-Content -LiteralPath (Join-Path $stageRoot 'resources/app/package.json') -Raw | ConvertFrom-Json
if ($stagedPackage.version -ne $package.version) { throw 'Staged application version does not match the release candidate.' }

# AI staging is a separate, explicit step; this command never downloads model dependencies.
$aiRoot = Join-Path $stageRoot 'resources/ai'
$manifestPath = Join-Path $aiRoot 'runtime-manifest.json'
Required-File $manifestPath
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or @($manifest.files).Count -lt 1 -or $manifest.commercialApproval -ne $false) {
    throw 'AI runtime metadata is missing, invalid, or no longer matches the reviewed candidate contract.'
}
$requiredAi = @(
    'ncnn/realesrgan-ncnn-vulkan.exe', 'ncnn/vcomp140.dll',
    'ncnn/models/realesrgan-x4plus.bin', 'ncnn/models/realesrgan-x4plus.param',
    'ncnn/models/realesrgan-x4plus-anime.bin', 'ncnn/models/realesrgan-x4plus-anime.param',
    'realhat/clarune-realhat.json', 'realhat/models/Real_HAT_GAN_SRx4.pth',
    'realhat/python/python.exe', 'realhat/python/python313.dll', 'realhat/python/python313.zip',
    'realhat/python/python313._pth', 'realhat/python/Lib/site-packages/torch/__init__.py',
    'realhat/python/Lib/site-packages/spandrel/__init__.py', 'licenses/notice-manifest.json'
)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$aiBase = [IO.Path]::GetFullPath($aiRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
foreach ($entry in $manifest.files) {
    if (-not $entry.path -or [IO.Path]::IsPathRooted($entry.path) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unsafe AI manifest entry.' }
    $path = [IO.Path]::GetFullPath((Join-Path $aiRoot $entry.path))
    if (-not $path.StartsWith($aiBase, [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($path)) { throw 'AI manifest path escapes the runtime or is duplicated.' }
    Required-File $path
    if ((Get-Item -LiteralPath $path).Length -ne $entry.bytes -or (Hash $path) -ne $entry.sha256) { throw "AI runtime integrity failure: $($entry.path)" }
}
foreach ($relative in $requiredAi) {
    $path = [IO.Path]::GetFullPath((Join-Path $aiRoot $relative))
    if (-not $seen.Contains($path)) { throw "Required AI file is not covered by the manifest: $relative" }
}
foreach ($file in Get-ChildItem -LiteralPath $aiRoot -Recurse -File) {
    if ($file.FullName -ne $manifestPath -and -not $seen.Contains($file.FullName)) { throw "Untracked file in AI runtime: $($file.FullName)" }
}
$hatConfig = Get-Content -LiteralPath (Join-Path $aiRoot 'realhat/clarune-realhat.json') -Raw | ConvertFrom-Json
if ($hatConfig.pythonExecutable -ne './python/python.exe') { throw 'Real-HAT must use the bundled relative Python path.' }

foreach ($name in @('LICENSE.md', 'THIRD_PARTY_NOTICES.md')) {
    Required-File (Join-Path $projectRoot $name)
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $stageRoot $name) -Force
}
$docTarget = Join-Path $stageRoot 'docs'
Assert-NoLinks $docTarget
New-Item -ItemType Directory -Path $docTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/INSTALLATION.md') -Destination $docTarget -Force
Write-Utf8 (Join-Path $stageRoot 'Prerequisites/README.txt') "Microsoft Visual C++ x64 Redistributable`nOfficial source: https://aka.ms/vc14/vc_redist.x64.exe`nThe installer was verified against its Microsoft Corporation digital signature during packaging.`nIf required by this computer, Clarune Setup asks before launching Microsoft's interactive installer and its normal UAC/terms interface.`nDeclining, cancelling or failing this prerequisite stops Clarune installation. A required reboot must finish before retrying.`nNo runtime DLL is copied from Windows System32. No automatic PATH changes or silent security-setting changes are performed by Clarune.`nMicrosoft's own installer and its displayed license terms govern this prerequisite. Redistribution reference is included under resources/ai/licenses/microsoft.`n"
Write-Utf8 (Join-Path $stageRoot 'resources/license-public-key.pem') $key.pem
Write-Utf8 (Join-Path $stageRoot 'clarune-installation.ini') "[Installation]`nAppId=$installerAppId`nVersion=$($package.version)`n"
$candidateNotice = @'
EVEING Clarune 1.0.0-rc.1 — 完整离线安装候选版

本版本用于安装、升级、卸载、离线激活和 GPU 兼容性验证，尚不标记为可正式商售。
包含通用、动漫及 Real-HAT 模型与运行环境。不会联网下载依赖；显卡驱动不包含在内。
Real-HAT 需要兼容 NVIDIA 显卡和驱动；不满足条件时不会安装驱动或修改其他 AI 软件。
默认只为当前 Windows 用户安装。可选择安装位置及是否创建桌面快捷方式。
若缺少 Microsoft Visual C++ x64 运行库，会先询问是否启动随包附带的微软安装器；
该系统组件会显示其正常 UAC 和条款界面。拒绝或安装失败会阻止 Clarune 继续安装。
不会修改文件关联、系统默认程序、浏览器设置，不会添加开机自启。
卸载只移除安装器登记的应用文件，保留用户设置、授权状态、历史队列及用户导出的图片。

离线激活由机器绑定数字签名验证。改期需要重新签发并导入，无法远程撤销旧授权。
本页是候选版说明，不是新增商业合同，也不要求接受未经确认的商业条款。
EVEING 原创代码声明和各第三方组件仍分别适用其各自许可；详见安装目录内 LICENSE.md、
THIRD_PARTY_NOTICES.md、resources/app/THIRD_PARTY_NOTICES.md 及 resources/ai/licenses。

此安装包未进行发行者代码签名，Windows 可能显示未知发布者或信誉提示。
请在正式收费前完成最终许可审查、GPU/安装回归和发布签名决策。
'@
if ($TestOnly) { $candidateNotice = "TEST-ONLY / 仅自动化安装验证，不得交付客户或用于商业签发。`n本安装器使用隔离测试应用标识及测试目录。`n`n" + $candidateNotice }
Write-Utf8 (Join-Path $stageRoot 'RELEASE_CANDIDATE_NOTICE.txt') $candidateNotice

# Fail closed if an issuer, issued customer license, private key or development repository was mixed into staging.
foreach ($item in Get-ChildItem -LiteralPath $stageRoot -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Stage contains a link: $($item.FullName)" }
    if ($item.Name -in @('.git', 'test-output', 'private-keys', 'license-issuer.mjs', 'EVEING License Desk.exe') -or $item.Extension -eq '.eveing-license') {
        throw "Administrator/test material must not enter the client installer: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
        # Key exports may have any extension; inspect their header without loading large model binaries.
        $stream = [IO.File]::OpenRead($item.FullName)
        try {
            $header = [byte[]]::new(8192)
            $length = $stream.Read($header, 0, $header.Length)
            if ([Text.Encoding]::ASCII.GetString($header, 0, $length) -match '-----BEGIN [A-Z ]*PRIVATE KEY-----') { throw 'A private key was found in the client stage.' }
        } finally { $stream.Dispose() }
    }
}
New-Item -ItemType Directory -Path $installerRoot -Force | Out-Null
Write-Output "Verified complete local AI payload. Public key SHA-256: $($key.fingerprint)"
Write-Output 'Compiling unsigned release candidate; no download, installation, app closure or commercial approval is performed.'
& $compiler "/DStageRoot=$stageRoot" "/DProjectRoot=$projectRoot" "/DInstallerOutput=$installerRoot" `
    "/DChineseMessages=$chineseMessages" "/DCandidateNoticeFile=$(Join-Path $stageRoot 'RELEASE_CANDIDATE_NOTICE.txt')" `
    "/DReleaseVersion=$($package.version)" "/DInstallerName=$installerName" "/DInstallerBuildNumber=$installerBuildNumber" "/DInstallerAppId=$installerAppId" "/DDirectoryName=$directoryName" "/DTestOnly=$([int][bool]$TestOnly)" "/DVCRedistSource=$vcRedist" `
    "/DVCMinMajor=$($vcVersion.FileMajorPart)" "/DVCMinMinor=$($vcVersion.FileMinorPart)" "/DVCMinBuild=$($vcVersion.FileBuildPart)" $definition
if ($LASTEXITCODE -ne 0) { throw "Inno compiler failed ($LASTEXITCODE). Any partial output has been retained for inspection." }
Required-File $installerFile
if (Get-ChildItem -LiteralPath $installerRoot -File | Where-Object { $_.Name -like "$installerName*.bin" }) { throw 'Unexpected split installer: release requires one complete EXE.' }
$evidence = [ordered]@{
    createdAt = [DateTime]::UtcNow.ToString('o'); version = $package.version; installerRevision = $InstallerRevision; candidateOnly = $true; testOnly = [bool]$TestOnly
    commercialApproval = $false; installer = $installerFile; installerSha256 = (Hash $installerFile)
    bytes = (Get-Item -LiteralPath $installerFile).Length; publisherCodeSigned = $false
    publicKeyFingerprint = $key.fingerprint; aiManifestSha256 = (Hash $manifestPath)
    vcRedistSha256 = (Hash $vcRedist); vcRedistMicrosoftSignatureValid = $true; vcRedistVersion = $vcVersion.FileVersion
    vcLicenseSha256 = (Hash $vcLicense)
    aiFileCount = $seen.Count; allAiFileHashesVerified = $true
    generatedBy = 'Inno Setup 7.1.0 x64'; installed = $false
}
Write-Utf8 (Join-Path $installerRoot "$installerName.evidence.json") ($evidence | ConvertTo-Json -Depth 4)
$evidence | ConvertTo-Json -Depth 4
