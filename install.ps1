<#
feishu-bridge 安装脚本
把 Project 源码复制到 DSH 插件目录，复制后做 SHA256 哈希比对，不一致立即失败。

用法：
  pwsh -File install.ps1              # 只装到 ~/.dsh/plugins/feishu-bridge
  pwsh -File install.ps1 -WhatIf      # 只打印将要做什么，不落盘
  pwsh -File install.ps1 -SkipNodeModules   # 不额外同步 profiles/desktop/node_modules 副本

退出码：0 成功，1 失败（源码缺失 / 哈希不一致 / 目标不可写）
#>

[CmdletBinding()]
param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$TargetDir = (Join-Path $env:USERPROFILE '.dsh\plugins\feishu-bridge'),
    [switch]$WhatIf,
    [switch]$SkipNodeModules
)

$ErrorActionPreference = 'Stop'
$script:Failed = $false

# 需要同步的文件（相对路径），与 package.json 的 files 字段保持一致。
# cordis.patch.yml 不在其中：项目里的那份只含占位符，现役那份含本机真实 appId/chatId，
# 覆盖它会让桥接在重启后直接不启动。它由项目外的本地配置维护，见 config.example.yml。
# lib\client.js 必须在清单里：package.json 声明了 exports["./client"] / dsh.client，
# 加载器在激活阶段会 readFileSync 它，缺文件会抛 MissingClientBundleError 并把 fiber 打成 FAILED。
$Payload = @(
    'index.js',
    'package.json',
    'lib\index.js',
    'lib\client.js',
    'locale\en.json',
    'locale\zh.json'
)

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash
}

function Write-Step([string]$Message) {
    Write-Host "[install] $Message"
}

function Fail([string]$Message) {
    Write-Host "[install][ERROR] $Message" -ForegroundColor Red
    $script:Failed = $true
}

Write-Step "source = $SourceDir"
Write-Step "target = $TargetDir"

if (-not (Test-Path -LiteralPath $SourceDir)) {
    Fail "source directory not found: $SourceDir"
    exit 1
}

# 0. 预检：源码侧文件必须齐全
$missing = @()
foreach ($rel in $Payload) {
    $src = Join-Path $SourceDir $rel
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { $missing += $rel }
}
if ($missing.Count -gt 0) {
    Fail "source is missing: $($missing -join ', ')"
    exit 1
}
Write-Step "precheck ok: $($Payload.Count) payload files present"

# 记录源码侧哈希，作为复制后的比对基准
$srcHashes = @{}
foreach ($rel in $Payload) { $srcHashes[$rel] = Get-Sha256 (Join-Path $SourceDir $rel) }

if ($WhatIf) {
    Write-Step "-WhatIf: no file written"
    foreach ($rel in $Payload) { Write-Host ("  {0}  {1}" -f $srcHashes[$rel].Substring(0,12), $rel) }
    exit 0
}

# 1. 复制
foreach ($rel in $Payload) {
    $src = Join-Path $SourceDir $rel
    $dst = Join-Path $TargetDir $rel
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        Write-Step "mkdir $dstDir"
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Step "copied $rel"
}

# 2. 哈希比对：不一致直接失败
foreach ($rel in $Payload) {
    $dst = Join-Path $TargetDir $rel
    if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) {
        Fail "target file missing after copy: $rel"
        continue
    }
    $dstHash = Get-Sha256 $dst
    if ($dstHash -ne $srcHashes[$rel]) {
        Fail "hash mismatch for ${rel}: expected $($srcHashes[$rel]), got $dstHash"
    } else {
        Write-Step "hash ok  $($dstHash.Substring(0,12))  $rel"
    }
}

# 3. node_modules 路径检查（仅当装到 DSH 默认目录时才有意义）
#    注意：~/.dsh/profiles/desktop/node_modules/feishu-bridge 通常是指向
#    ~/.dsh/plugins/feishu-bridge 的 junction（已实测确认），两边本来就是同一份文件，
#    不需要也不应该再复制一遍。这里只做校验，不写文件。
#    指定了别的 -TargetDir（例如临时目录做验证）时跳过，这条检查与那个目标无关。
$isDefaultTarget = $false
try {
    # 归一化后再比：Resolve-Path 不裁尾部分隔符，写成 "...\feishu-bridge\" 或 "...\.\"
    # 会被判成「非默认」，导致两项安全检查被静默跳过（fail-open，QA 实测复现）。
    $norm = {
        param($p)
        $r = Resolve-Path -LiteralPath $p -ErrorAction Stop
        return $r.Path.TrimEnd([char]92, [char]47)
    }
    $isDefaultTarget = ((& $norm $TargetDir) -eq (& $norm (Join-Path $env:USERPROFILE '.dsh\plugins\feishu-bridge')))
} catch { $isDefaultTarget = $false }
if (-not $SkipNodeModules -and -not $isDefaultTarget) {
    Write-Step "target is not the DSH default dir - skipping node_modules link check"
} elseif (-not $SkipNodeModules) {
    $nm = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\feishu-bridge'
    if (-not (Test-Path -LiteralPath $nm)) {
        Write-Step "skip node_modules check (path not found): $nm"
    } else {
        $item = Get-Item -LiteralPath $nm -Force
        if ($item.LinkType) {
            $resolved = $item.Target
            if ($resolved -and (Test-Path -LiteralPath $resolved)) {
                $a = (Resolve-Path -LiteralPath $resolved).Path
                $b = (Resolve-Path -LiteralPath $TargetDir).Path
                if ($a -eq $b) {
                    Write-Step "node_modules is a link to the install target - same files, nothing to copy"
                } else {
                    Fail "node_modules link points elsewhere: $a (expected $b)"
                }
            } else {
                Write-Step "node_modules is a link ($($item.LinkType)) - verified through target"
            }
        } else {
            # 非链接：说明它不是预期的 junction，只告警提示人工确认，本脚本不写这个路径。
            Write-Host "[install][WARN] node_modules 下的 feishu-bridge 不是 junction，而是独立目录。" -ForegroundColor Yellow
            Write-Host "[install][WARN] 本脚本不写该路径（避免动到 DSH 加载的那一份），请人工确认它是否为过期副本。" -ForegroundColor Yellow
            foreach ($rel in $Payload) {
                $dstHash = Get-Sha256 (Join-Path $nm $rel)
                if ($dstHash -ne $srcHashes[$rel]) { Fail "stale node_modules copy (not written by this script): $rel" }
            }
            Write-Step "node_modules copy matches source (verified, not written)"
        }
    }
}

# 4. 安全检查：安装目标里的 cordis.patch.yml 必须仍含真实值（本机配置，不进仓库）
$liveCfg = Join-Path $TargetDir 'cordis.patch.yml'
if (-not $isDefaultTarget) {
    Write-Step "target is not the DSH default dir - skipping live config check"
} elseif (Test-Path -LiteralPath $liveCfg) {
    $liveText = Get-Content -LiteralPath $liveCfg -Raw
    if ($liveText -match 'appId:\s*"?"?\s*$' -or $liveText -match 'appId:\s*""') {
        Write-Host "[install][WARN] 目标 cordis.patch.yml 的 appId 是空的：桥接重启后不会启动。" -ForegroundColor Yellow
        Write-Host "[install][WARN] 请把真实值填进 $liveCfg（模板见项目 config.example.yml）。" -ForegroundColor Yellow
    } else {
        Write-Step "live config still has real appId/chatId - not touched by this script"
    }
} else {
    Write-Host "[install][WARN] 目标缺少 cordis.patch.yml，DSH 挂载会失败。" -ForegroundColor Yellow
    Write-Host "[install][WARN] 请按 config.example.yml 创建它（含本机真实 appId/chatId）。" -ForegroundColor Yellow
}

if ($script:Failed) {
    Write-Host "[install] FAILED - target does not match source" -ForegroundColor Red
    exit 1
}

Write-Host "[install] OK - copied and verified" -ForegroundColor Green
Write-Host "[install] 下一步：重启 DSH 使插件生效（DSH 退出时不会自动重载插件）"
exit 0
