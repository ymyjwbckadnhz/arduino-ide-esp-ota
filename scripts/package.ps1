<#
.SYNOPSIS
  编译并打包为 .vsix

.DESCRIPTION
  不依赖 @vscode/vsce，直接生成符合 VSIX 结构的 zip。
  .vsix 本质就是一个 zip：
    extension.vsixmanifest
    [Content_Types].xml
    extension/...（package.json、out/、README.md 等）

.EXAMPLE
  .\scripts\package.ps1
  .\scripts\package.ps1 -SkipCompile
#>

[CmdletBinding()]
param(
  [switch]$SkipCompile,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) { $OutDir = $repo }

$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
$displayName = $pkg.displayName
$description = $pkg.description
$engine = $pkg.engines.vscode

if (-not $SkipCompile) {
  Write-Host "==> 编译 TypeScript" -ForegroundColor Cyan
  $tsc = Join-Path $repo 'node_modules\.bin\tsc.cmd'
  if (Test-Path $tsc) {
    & $tsc -p (Join-Path $repo 'tsconfig.json') 2>&1 | Out-String | Write-Host
  } else {
    & npx --no-install tsc -p (Join-Path $repo 'tsconfig.json') 2>&1 | Out-String | Write-Host
  }
}
if (-not (Test-Path (Join-Path $repo 'out\extension.js'))) {
  throw '编译失败：没有生成 out/extension.js'
}

Write-Host "==> 打包 $name-$version.vsix" -ForegroundColor Cyan
$stage = Join-Path $repo '_vsix'
Remove-Item $stage -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'extension\out') | Out-Null

Copy-Item (Join-Path $repo 'package.json') (Join-Path $stage 'extension\')
Copy-Item (Join-Path $repo 'out\extension.js') (Join-Path $stage 'extension\out\')
foreach ($f in @('README.md', 'LICENSE')) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $stage 'extension\') }
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="$($pkg.publisher)" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@
[System.IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), ($manifest -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

$ct = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
[System.IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), $ct, (New-Object System.Text.UTF8Encoding($false)))

$vsix = Join-Path $OutDir "$name-$version.vsix"
Remove-Item $vsix -EA SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $vsix)
Remove-Item $stage -Recurse -Force

Write-Host "==> 完成: $vsix ($([math]::Round((Get-Item $vsix).Length / 1KB, 1)) KB)" -ForegroundColor Green
Write-Host ''
Write-Host '安装：把该文件复制到  或  ~/.arduinoIDE/plugins/  后重启 Arduino IDE'
Write-Host "      Windows: $env:USERPROFILE\.arduinoIDE\plugins\"
Write-Host '      macOS/Linux: ~/.arduinoIDE/plugins/'
