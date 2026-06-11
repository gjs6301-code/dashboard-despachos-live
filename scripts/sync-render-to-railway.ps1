param(
  [string]$RailwayCommand = "railway",
  [string]$Service = "dashboard-despachos",
  [string]$Volume = "dashboard-despachos-data"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command $RailwayCommand -ErrorAction SilentlyContinue)) {
  $npmPrefix = npm config get prefix
  $candidate = Join-Path $npmPrefix "railway.cmd"
  if (Test-Path -LiteralPath $candidate) {
    $RailwayCommand = $candidate
  } else {
    throw "Railway CLI not found. Install it with: npm install -g @railway/cli"
  }
}

$securePassword = Read-Host "Clave de Render para el usuario de .env" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:RENDER_WWP_PASSWORD = $plainPassword

  Write-Host "1/4 Descargando data actual desde Render..."
  node sync-from-prod.js

  Write-Host "2/4 Confirmando DATA_DIR=/data en Railway..."
  & $RailwayCommand variable set DATA_DIR=/data --service $Service --skip-deploys | Out-Null

  Write-Host "3/4 Subiendo data-local al volumen Railway..."
  Get-ChildItem -Force -LiteralPath data-local | ForEach-Object {
    $remote = "/" + $_.Name
    Write-Host "   $($_.Name) -> $remote"
    & $RailwayCommand volume files --volume $Volume upload $_.FullName $remote --overwrite | Out-Null
  }

  Write-Host "4/4 Redeploy de Railway..."
  & $RailwayCommand redeploy --service $Service --yes | Out-Null

  Write-Host "Listo. Espera 30-60 segundos y refresca Railway con Ctrl+F5."
} finally {
  $env:RENDER_WWP_PASSWORD = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
