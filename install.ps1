$manifestName = "com.br.download.manager"
$exePath = Join-Path $PSScriptRoot "br-dl-windows.exe"
$manifestPath = Join-Path $PSScriptRoot "manifest-win.json"

# Create manifest file for Windows
$manifest = @{
    name = $manifestName
    description = "Bridge for aria2 Download Manager (Rust)"
    path = $exePath
    type = "stdio"
    allowed_origins = @("chrome-extension://obbofbgglodjehllcnfggbmjhpcphlbl/")
} | ConvertTo-Json

$manifest | Out-File -FilePath $manifestPath -Encoding utf8

# Register to Chrome
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$manifestName"
if (!(Test-Path $registryPath)) { New-Item -Path $registryPath -Force }
Set-ItemProperty -Path $registryPath -Name "(Default)" -Value $manifestPath

Write-Host "Installation Complete. Please load the extension in Chrome." -ForegroundColor Green
