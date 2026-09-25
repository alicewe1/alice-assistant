# ============================================================
#  部署脚本：把生产构建的 exe 装进分发目录
# ------------------------------------------------------------
#  流程：停进程 → 备份旧 exe → 覆盖 → 重启
#  回滚：把 <分发目录>\新alice助手.exe.rollback-* 复制回去
#
#  用法：
#    pwsh -File deploy-aijail-opt.ps1                        # 用默认路径
#    pwsh -File deploy-aijail-opt.ps1 -Pkg 'D:\我的分发目录'   # 指定分发目录
#    pwsh -File deploy-aijail-opt.ps1 -WhatIfOnly            # 只打印计划，不动手
#
#  ══ 为什么路径改成参数而不是写死 ═══════════════════════════════════
#  原先 $pkg / $built 是写死的 F:\重构ui\... 绝对路径，换台机器、
#  换个克隆位置脚本直接抛异常；这类本机路径也不该出现在公开仓库里。
#  现在按「脚本自身位置」推导默认值 —— 脚本在 <仓库根>/ 下，
#  分发目录默认取仓库同级的「新alice助手」。
# ============================================================
param(
    [switch]$WhatIfOnly,
    # 分发目录（含 exe 与 resources\）
    [string]$Pkg,
    # 生产构建产物
    [string]$Built
)

$ErrorActionPreference = 'Stop'

# 脚本在仓库根，src-tauri 是它的同级目录
$repoRoot = $PSScriptRoot

if (-not $Built) {
    $Built = Join-Path $repoRoot 'src-tauri\target\release\alice-ui.exe'
}
if (-not $Pkg) {
    # 默认：仓库同级的「新alice助手」分发目录
    $Pkg = Join-Path (Split-Path -Parent $repoRoot) '新alice助手'
}

if (-not (Test-Path -LiteralPath $Pkg)) {
    throw "分发目录不存在：$Pkg`n用 -Pkg 指定一个含 resources\ 的目录。"
}

# exe 名随分发形态（这里固定叫「新alice助手.exe」）。
# 用码点拼出来是为了让本脚本自身不依赖文件编码 —— 源码里直接写中文
# 在某些编辑/终端组合下会被存成 GBK，PowerShell 读取时就成了乱码文件名。
$exeName = [string]::Concat(
    [char]0x65B0, [char]0x0061, [char]0x006C, [char]0x0069,
    [char]0x0063, [char]0x0065, [char]0x52A9, [char]0x624B
) + '.exe'
$dst = Join-Path $Pkg $exeName

if (-not (Test-Path -LiteralPath $Built)) {
    throw "找不到构建产物：$Built`n先构建：cargo build --release --features custom-protocol --manifest-path `"$repoRoot\src-tauri\Cargo.toml`""
}

Write-Host "仓库根  : $repoRoot"
Write-Host "构建产物: $Built"
Write-Host "分发目录: $Pkg"
Write-Host "目标 exe: $dst"
Write-Host ''

# 进程名 = exe 去掉扩展名
$procName = [System.IO.Path]::GetFileNameWithoutExtension($exeName)
$running = Get-Process -Name $procName -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "[1/4] 停止运行中的进程：$($running.Id -join ', ')"
    if (-not $WhatIfOnly) {
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 1200
    }
} else {
    Write-Host '[1/4] 没有运行中的进程'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$dst.rollback-$stamp"

Write-Host "[2/4] 备份现有 exe -> $(Split-Path $bak -Leaf)"
if (-not $WhatIfOnly) {
    if (Test-Path -LiteralPath $dst) {
        Copy-Item -LiteralPath $dst -Destination $bak -Force
    } else {
        Write-Host '      目标尚不存在，跳过备份'
    }
}

Write-Host "[3/4] 部署：$Built -> $dst"
if (-not $WhatIfOnly) {
    Copy-Item -LiteralPath $Built -Destination $dst -Force
    $new = Get-Item -LiteralPath $dst
    $sha = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
    Write-Host ("      {0} 字节，mtime {1}" -f $new.Length, $new.LastWriteTime)
    Write-Host ("      SHA256 {0}" -f $sha)
}

Write-Host '[4/4] 启动'
if (-not $WhatIfOnly) {
    Start-Process -FilePath $dst -WorkingDirectory $Pkg
    Write-Host '      已启动'
} else {
    Write-Host '      (WhatIfOnly：未执行任何操作)'
}

Write-Host ''
Write-Host "回滚命令：Copy-Item -LiteralPath '$bak' -Destination '$dst' -Force"
