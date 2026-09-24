[CmdletBinding()]
param(
    [string]$Target,
    [switch]$PrepareNotices,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
$allowedTarget = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'outputs/EVEINGClarune_ReleaseCandidate/resources/ai'))
if (-not $Target) { $Target = $allowedTarget }
$Target = [IO.Path]::GetFullPath($Target)
if (-not $Target.Equals($allowedTarget, [StringComparison]::OrdinalIgnoreCase)) { throw 'Target must be the dedicated ReleaseCandidate/resources/ai directory.' }
if (Test-Path -LiteralPath $Target) { throw 'Target already exists. Refusing to overwrite or merge any runtime.' }
$pythonRoot = 'D:/Comfy_UI/ComfyUI_windows_portable/python_embeded'
$siteRoot = [IO.Path]::GetFullPath((Join-Path $pythonRoot 'Lib/site-packages'))
$ncnnRoot = Join-Path $workspaceRoot 'work/engine-baseline/runtime-full'
$hatRoot = Join-Path $workspaceRoot 'work/realhat-face-test'
$noticeRoot = Join-Path $workspaceRoot 'work/release-notices'
$noticeIndex = Join-Path $noticeRoot 'notice-manifest.json'
$spandrelCommit = '724cca389f28c38e1050689d4862a452fd644484'
$checkedLinks = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Child-Path([string]$Root, [string]$Relative) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath((Join-Path $base $Relative))
    if (-not $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes allowed root: $Relative" }
    return $full
}
function Assert-NoLinks([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($item) {
        if ($checkedLinks.Contains($item.FullName)) { break }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $($item.FullName)" }
        [void]$checkedLinks.Add($item.FullName)
        $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Notice preparation is explicit and downloads only small official license/source snapshots.
# Normal staging never uses the network and never invokes the source Python interpreter.
if ($PrepareNotices) {
    New-Item -ItemType Directory -Path $noticeRoot -Force | Out-Null
    Assert-NoLinks $noticeRoot
    $noticeItems = [Collections.Generic.List[object]]::new()
    function Add-Notice([string]$Relative, [string]$Url, [string]$Local, [string]$GitBlob) {
        $path = Child-Path $noticeRoot $Relative
        $existing = Split-Path -Parent $path
        while (-not (Test-Path -LiteralPath $existing)) { $existing = Split-Path -Parent $existing }
        Assert-NoLinks $existing
        if (Test-Path -LiteralPath $path) { Assert-NoLinks $path }
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        if ($Local) { Copy-Item -LiteralPath $Local -Destination $path -Force }
        elseif (-not (Test-Path -LiteralPath $path)) { Invoke-WebRequest -Uri $Url -OutFile $path }
        if ((Get-Item -LiteralPath $path).Length -lt 10) { throw "Incomplete notice: $Relative" }
        if ($GitBlob) {
            $bytes = [IO.File]::ReadAllBytes($path)
            $prefix = [Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
            $sha = [Security.Cryptography.SHA1]::Create()
            $actual = [Convert]::ToHexString($sha.ComputeHash($prefix + $bytes)).ToLowerInvariant()
            $sha.Dispose()
            if ($actual -ne $GitBlob) { throw "Upstream git blob mismatch: $Relative" }
        }
        $noticeItems.Add([pscustomobject]@{ path=$Relative; source=$Url; sha256=(Hash $path) })
    }
    $tree = Invoke-RestMethod "https://api.github.com/repos/chaiNNer-org/spandrel/git/trees/${spandrelCommit}?recursive=1"
    if ($tree.truncated) { throw 'Spandrel source tree was truncated.' }
    $licenses = @($tree.tree | Where-Object { $_.type -eq 'blob' -and ($_.path -eq 'LICENSE' -or $_.path.StartsWith('libs/spandrel/')) -and $_.path -match '(^|/)(LICENSE[^/]*|NOTICE[^/]*|COPYING[^/]*)$' })
    if ($licenses.Count -lt 40) { throw 'Spandrel architecture notice set is incomplete.' }
    foreach ($entry in $licenses) {
        $relative = 'spandrel/' + ($entry.path -replace '^libs/spandrel/spandrel/', '')
        Add-Notice $relative "https://raw.githubusercontent.com/chaiNNer-org/spandrel/$spandrelCommit/$($entry.path)" '' $entry.sha
    }
    $sourceRoot = Join-Path $workspaceRoot 'work/engine-baseline/source'
    $localNotices = @(
        @('ncnn/worker-LICENSE.txt', 'LICENSE', 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/LICENSE'),
        @('ncnn/ncnn-LICENSE.txt', 'src/ncnn/LICENSE.txt', 'https://github.com/Tencent/ncnn/blob/6125c9f47cd14b589de0521350668cf9d3d37e3c/LICENSE.txt'),
        @('ncnn/glslang-LICENSE.txt', 'src/ncnn/glslang/LICENSE.txt', 'https://github.com/KhronosGroup/glslang/blob/4afd69177258d0636f78d2c4efb823ab6382a187/LICENSE.txt'),
        @('ncnn/libwebp-COPYING.txt', 'src/libwebp/COPYING', 'https://github.com/webmproject/libwebp/blob/8ea81561d2fdd382da60f57958741a7c23a18eb6/COPYING'),
        @('ncnn/libwebp-PATENTS.txt', 'src/libwebp/PATENTS', 'https://github.com/webmproject/libwebp/blob/8ea81561d2fdd382da60f57958741a7c23a18eb6/PATENTS'),
        @('ncnn/stb_image-header-and-license.txt', 'src/stb_image.h', 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/src/stb_image.h'),
        @('ncnn/stb_image_write-header-and-license.txt', 'src/stb_image_write.h', 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/src/stb_image_write.h'),
        @('ncnn/win32dirent-header-and-license.txt', 'src/win32dirent.h', 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/37026f49824c5cf84062e7c6a5dd71445dcf610f/src/win32dirent.h')
    )
    foreach ($entry in $localNotices) { Add-Notice $entry[0] $entry[2] (Join-Path $sourceRoot $entry[1]) '' }
    Add-Notice 'models/Real-HAT-LICENSE.txt' 'https://github.com/XPixelGroup/HAT/blob/1638a9a822581657811867bf670717f8371fc3e5/LICENSE' (Join-Path $hatRoot 'official/LICENSE') ''
    Add-Notice 'models/Real-ESRGAN-LICENSE.txt' 'https://raw.githubusercontent.com/xinntao/Real-ESRGAN/685d429c81888252bdb10f56c7754baededc3823/LICENSE' '' ''
    Add-Notice 'nvidia/CUDA-13.0-EULA.html' 'https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html' '' ''
    Add-Notice 'nvidia/cuDNN-EULA.html' 'https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html' '' ''
    Add-Notice 'nvidia/cuDNN-ACKNOWLEDGEMENTS.html' 'https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/acknowledgements.html' '' ''
    Add-Notice 'nvidia/CUPTI-13.0-LICENSES.html' 'https://docs.nvidia.com/cupti/13.0.0/copyright-and-licenses/index.html' '' ''
    Add-Notice 'microsoft/Visual-Studio-2022-Redistribution.html' 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution' '' ''
    [pscustomobject]@{ schemaVersion=1; collectedAt=(Get-Date).ToUniversalTime().ToString('o'); spandrelCommit=$spandrelCommit; commercialApproval=$false; files=@($noticeItems) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $noticeIndex -Encoding utf8
}
if (-not (Test-Path -LiteralPath $noticeIndex)) { throw 'Missing notice collection. Run -PrepareNotices -PlanOnly first.' }
$notices = Get-Content -LiteralPath $noticeIndex -Raw | ConvertFrom-Json
if ($notices.schemaVersion -ne 1 -or $notices.spandrelCommit -ne $spandrelCommit -or @($notices.files).Count -lt 55) { throw 'Unexpected/incomplete notice manifest.' }
foreach ($entry in $notices.files) {
    $path = Child-Path $noticeRoot $entry.path
    Assert-NoLinks $path
    if ((Hash $path) -ne $entry.sha256) { throw "Notice integrity failure: $($entry.path)" }
}

$packages = @(
    @('torch','2.13.0+cu130',@('torch','functorch','torchgen')),
    @('torchvision','0.28.0+cu130',@('torchvision')),
    @('spandrel','0.4.2',@('spandrel')),
    @('numpy','2.5.1',@('numpy','numpy.libs')),
    @('pillow','12.3.0',@('PIL')),
    @('einops','0.8.2',@('einops')),
    @('safetensors','0.8.0',@('safetensors')),
    @('typing_extensions','4.16.0',@('typing_extensions.py')),
    @('filelock','3.32.0',@('filelock')),
    @('setuptools','83.0.0',@('setuptools','_distutils_hack')),
    @('sympy','1.14.0',@('sympy','isympy.py')),
    @('networkx','3.6.1',@('networkx')),
    @('jinja2','3.1.6',@('jinja2')),
    @('fsspec','2026.7.0',@('fsspec')),
    @('mpmath','1.3.0',@('mpmath')),
    @('markupsafe','3.0.3',@('markupsafe'))
)
$omittedDlls = @('nvperf_host.dll','cusolverMg64_12.dll','nvrtc64_130_0.alt.dll')
$spandrelFiles = @(
    'spandrel/__init__.py',
    'spandrel/__helpers/__init__.py','spandrel/__helpers/canonicalize.py','spandrel/__helpers/loader.py',
    'spandrel/__helpers/model_descriptor.py','spandrel/__helpers/registry.py','spandrel/__helpers/size_req.py','spandrel/__helpers/unpickler.py',
    'spandrel/architectures/__init__.py','spandrel/architectures/__arch_helpers/__init__.py','spandrel/architectures/__arch_helpers/padding.py',
    'spandrel/architectures/HAT/__init__.py','spandrel/architectures/HAT/__arch/__init__.py','spandrel/architectures/HAT/__arch/HAT.py',
    'spandrel/util/__init__.py','spandrel/util/timm/__init__.py','spandrel/util/timm/__drop.py','spandrel/util/timm/__helpers.py','spandrel/util/timm/__weight_init.py'
)
$selectedNotices = @($notices.files | Where-Object { -not $_.path.StartsWith('spandrel/') -or $_.path -in @('spandrel/LICENSE','spandrel/architectures/HAT/__arch/LICENSE','spandrel/util/timm/LICENSE') })
$files = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
function Add-File([string]$Source, [string]$Relative, [string]$Component, [string]$Origin, [string]$Expected) {
    Assert-NoLinks $Source
    $item = Get-Item -LiteralPath $Source
    if ($item.PSIsContainer) { throw "Expected a file: $Source" }
    $destination = Child-Path $Target $Relative
    if ($files.ContainsKey($destination)) {
        if (-not $files[$destination].source.Equals($item.FullName, [StringComparison]::OrdinalIgnoreCase)) { throw "Duplicate target: $Relative" }
        return
    }
    $files.Add($destination, [pscustomobject]@{ source=$item.FullName; path=($Relative -replace '\\','/'); component=$Component; origin=$Origin; bytes=$item.Length; expected=$Expected; sha256=$null })
}

foreach ($package in $packages) {
    $name,$version,$tops = $package
    $dist = "$name-$version.dist-info"
    $meta = Get-Content -LiteralPath (Join-Path $siteRoot "$dist/METADATA") -Raw
    if ($meta -notmatch "(?m)^Version: $([regex]::Escape($version))\r?$" -or $meta -notmatch "(?im)^Name: $([regex]::Escape($name).Replace('_','[-_]'))\r?$") { throw "Package version/name mismatch: $dist" }
    $allowed = @($tops) + $dist
    $origin = if ($name -in @('torch','torchvision')) { "https://download.pytorch.org/whl/cu130/$name/" } else { "https://pypi.org/project/$name/$version/" }
    $records = Get-Content -LiteralPath (Join-Path $siteRoot "$dist/RECORD") | ConvertFrom-Csv -Header 'Path','Hash','Size'
    foreach ($record in $records) {
        $relative = $record.Path.Replace('\','/')
        if ($relative -match '(^|/)__pycache__/|\.py[co]$|/direct_url\.json$|\.pth$') { continue }
        if ($name -eq 'spandrel') {
            if ($relative -eq "$dist/RECORD") { continue }
            if (-not $relative.StartsWith("$dist/") -and $relative -notin $spandrelFiles) { continue }
        }
        $top = $relative.Split('/')[0]
        if ($top -notin $allowed) {
            if ($relative.StartsWith('../')) { continue }
            throw "RECORD includes unexpected top-level file: $name / $relative"
        }
        if (($relative.Split('/')[-1]) -in $omittedDlls -and $relative.StartsWith('torch/lib/')) { continue }
        Add-File (Child-Path $siteRoot $relative) "realhat/python/Lib/site-packages/$relative" "$name==$version" $origin $record.Hash
    }
}
$pythonFiles = @('_asyncio.pyd','_bz2.pyd','_ctypes.pyd','_decimal.pyd','_elementtree.pyd','_hashlib.pyd','_lzma.pyd','_multiprocessing.pyd','_overlapped.pyd','_queue.pyd','_socket.pyd','_sqlite3.pyd','_ssl.pyd','_uuid.pyd','_wmi.pyd','_zoneinfo.pyd','libcrypto-3.dll','libffi-8.dll','libssl-3.dll','LICENSE.txt','pyexpat.pyd','python.cat','python.exe','python3.dll','python313.dll','python313.zip','pythonw.exe','select.pyd','sqlite3.dll','unicodedata.pyd','vcruntime140_1.dll','vcruntime140.dll','winsound.pyd')
if ((Get-Item -LiteralPath (Join-Path $pythonRoot 'python.exe')).VersionInfo.FileVersion -ne '3.13.14') { throw 'Python version changed; re-audit ABI and root file list.' }
foreach ($file in $pythonFiles) { Add-File (Join-Path $pythonRoot $file) "realhat/python/$file" 'CPython 3.13.14 embedded x64' 'https://www.python.org/downloads/release/python-31314/' '' }
$ncnnFiles = @(
    @('realesrgan-ncnn-vulkan.exe','07e49f7cbb4ede01ae4dd4c399d3a7e5846e3d2085c3128eff881e55cb7b1a0c'),
    @('vcomp140.dll','8f72ef2e483465444b2059fc6744d6cb22cd8d8a27f6fa56befd2a42dcd0f78b'),
    @('models/realesrgan-x4plus.bin','713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf'),
    @('models/realesrgan-x4plus.param','35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86'),
    @('models/realesrgan-x4plus-anime.bin','fe01c269cfd10cdef8e018ab66ebe750cf79c7af4d1f9c16c737e1295229bacc'),
    @('models/realesrgan-x4plus-anime.param','2b8fb6e0ae4d2d85704ca08c119a2f5ea40add4f2ecd512eb7f4cd44b6127ed4')
)
foreach ($entry in $ncnnFiles) { Add-File (Join-Path $ncnnRoot $entry[0]) "ncnn/$($entry[0])" 'Real-ESRGAN ncnn v0.2.0 / models v0.2.5.0' 'https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0' $entry[1] }
Add-File (Join-Path $hatRoot 'models/Real_HAT_GAN_SRx4.pth') 'realhat/models/Real_HAT_GAN_SRx4.pth' 'Real-HAT ordinary x4' 'https://drive.google.com/file/d/1Ma12vCWT27P9M99-s2RXnynKN-OQsBrv/view' 'f5b1e3bbbb05147ca2beefcc715279cb647d7976cbda67d62ea7e6e20d5ffcc7'
foreach ($entry in $selectedNotices) { Add-File (Child-Path $noticeRoot $entry.path) "licenses/$($entry.path)" 'Supplemental notices' $entry.source $entry.sha256 }

# All source integrity checks finish before creating the runtime destination.
$totalBytes = 0L
foreach ($entry in $files.Values) {
    $entry.sha256 = Hash $entry.source
    if ($entry.expected.StartsWith('sha256=')) {
        $expected64 = $entry.expected.Substring(7).Replace('-','+').Replace('_','/')
        $expected64 = $expected64.PadRight([int]([math]::Ceiling($expected64.Length / 4.0) * 4), '=')
        $expectedHash = [Convert]::ToHexString([Convert]::FromBase64String($expected64)).ToLowerInvariant()
        if ($entry.sha256 -ne $expectedHash) { throw "Python RECORD integrity mismatch: $($entry.path)" }
    } elseif ($entry.expected -match '^[a-fA-F0-9]{64}$') {
        if ($entry.sha256 -ne $entry.expected.ToLowerInvariant()) { throw "Pinned integrity mismatch: $($entry.path)" }
    }
    elseif ($entry.expected -and $entry.expected -notmatch '^sha256=') { throw "Unsupported RECORD digest: $($entry.path)" }
    $totalBytes += $entry.bytes
}
Write-Output "Validated $($files.Count) files, $totalBytes bytes ($([math]::Round($totalBytes / 1GB, 3)) GiB). No source files modified."
Write-Output "Excluded pending-runtime-test DLLs: $($omittedDlls -join ', '). Commercial approval: NOT ASSERTED."
if ($PlanOnly) { return }
$existingParent = Split-Path -Parent $Target
while (-not (Test-Path -LiteralPath $existingParent)) { $existingParent = Split-Path -Parent $existingParent }
Assert-NoLinks $existingParent
New-Item -ItemType Directory -Path $Target -ErrorAction Stop | Out-Null
foreach ($entry in $files.Values) {
    $destination = Child-Path $Target $entry.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    [IO.File]::Copy($entry.source, $destination, $false)
    if ((Hash $destination) -ne $entry.sha256) { throw "Copied file checksum mismatch; incomplete target retained for review: $($entry.path)" }
}
$generated = @{
    'realhat/python/python313._pth' = "python313.zip`n.`nLib/site-packages`nimport site`n"
    'realhat/clarune-realhat.json' = "{`"pythonExecutable`":`"./python/python.exe`"}`n"
    'README-RC.txt' = "Local release candidate. Commercial approval is not asserted. GPU drivers are not included. No online dependency downloads at runtime. Excluded DLLs require isolated GPU verification: $($omittedDlls -join ', ').`n"
    'realhat/python/Lib/site-packages/spandrel/__helpers/main_registry.py' = "# Modified by EVEING Clarune, 2026-09-17: register HAT only.`n# Derived from Spandrel 0.4.2 (MIT); see licenses/spandrel/LICENSE.`nfrom ..architectures.HAT import HATArch`nfrom .registry import ArchRegistry, ArchSupport`n`nMAIN_REGISTRY = ArchRegistry()`nMAIN_REGISTRY.add(ArchSupport.from_architecture(HATArch()))`n"
    'licenses/notice-manifest.json' = ([pscustomobject]@{schemaVersion=1;spandrelCommit=$spandrelCommit;commercialApproval=$false;files=$selectedNotices}|ConvertTo-Json -Depth 5)
    'realhat/python/Lib/site-packages/spandrel-0.4.2.dist-info/CLARUNE-HAT-ONLY.json' = ([pscustomobject]@{
        upstream='spandrel 0.4.2'; sourceCommit=$spandrelCommit; upstreamWheelSha256='6c93e3ecbeb0e548fd2df45a605472b34c1614287c56b51bb33cdef7ae5235b5';
        originalRecordSha256=(Hash (Join-Path $siteRoot 'spandrel-0.4.2.dist-info/RECORD'));
        originalRegistrySha256=(Hash (Join-Path $siteRoot 'spandrel/__helpers/main_registry.py'));
        modifiedBy='EVEING Clarune'; modificationDate='2026-09-17';
        changes=@('Only HAT architecture and its padding helper are retained.','main_registry.py replaced with HAT-only registration.','RECORD regenerated for this derived subset.');
        retainedSourceFiles=$spandrelFiles; commercialApproval=$false
    }|ConvertTo-Json -Depth 4)
}
$manifestFiles = @($files.Values | Sort-Object path | Select-Object path,component,origin,bytes,sha256)
foreach ($relative in $generated.Keys) {
    $path = Child-Path $Target $relative
    [IO.File]::WriteAllText($path, $generated[$relative], [Text.UTF8Encoding]::new($false))
    $manifestFiles += [pscustomobject]@{ path=$relative; component='Generated Clarune runtime configuration'; origin='tools/stage-ai-runtime.ps1'; bytes=(Get-Item -LiteralPath $path).Length; sha256=(Hash $path) }
}
$recordRows = foreach ($entry in $manifestFiles | Where-Object { $_.path -match '^realhat/python/Lib/site-packages/spandrel(/|-0\.4\.2\.dist-info/)' } | Sort-Object path) {
    $relative = $entry.path.Replace('realhat/python/Lib/site-packages/','')
    $digest = [Convert]::ToBase64String([Convert]::FromHexString($entry.sha256)).TrimEnd('=').Replace('+','-').Replace('/','_')
    "$relative,sha256=$digest,$($entry.bytes)"
}
$recordRelative = 'realhat/python/Lib/site-packages/spandrel-0.4.2.dist-info/RECORD'
$recordPath = Child-Path $Target $recordRelative
$recordRows += 'spandrel-0.4.2.dist-info/RECORD,,'
[IO.File]::WriteAllText($recordPath, (($recordRows -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
$manifestFiles += [pscustomobject]@{path=$recordRelative;component='Spandrel HAT-only derived RECORD';origin='tools/stage-ai-runtime.ps1';bytes=(Get-Item -LiteralPath $recordPath).Length;sha256=(Hash $recordPath)}
[pscustomobject]@{ schemaVersion=1; stagedAt=(Get-Date).ToUniversalTime().ToString('o'); commercialApproval=$false; isolatedGpuVerificationRequired=$true; omittedDlls=$omittedDlls; files=$manifestFiles } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Target 'runtime-manifest.json') -Encoding utf8
Write-Output "Staged new runtime: $Target. Original environments are unchanged. Run isolated GPU and offline installation checks before release."
