param(
  [string]$EnvFile = ".env",
  [string]$RailwayCommand = "railway"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

if (-not (Get-Command $RailwayCommand -ErrorAction SilentlyContinue)) {
  $npmPrefix = npm config get prefix
  $candidate = Join-Path $npmPrefix "railway.cmd"
  if (Test-Path -LiteralPath $candidate) {
    $RailwayCommand = $candidate
  } else {
    throw "Railway CLI not found. Install it with: npm install -g @railway/cli"
  }
}

$allowedKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
  "NODE_ENV",
  "DATA_DIR",
  "ODOO_URL",
  "ODOO_DB",
  "ODOO_USER",
  "ODOO_API_KEY",
  "JWT_SECRET",
  "COMPANY_NAME",
  "CONT_SHEETS_ID",
  "CONT_SHEETS_GID",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM"
) | ForEach-Object { [void]$allowedKeys.Add($_) }

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
    return
  }

  $parts = $line -split "=", 2
  $key = $parts[0].Trim()
  $value = $parts[1].Trim()

  if (-not $allowedKeys.Contains($key)) {
    return
  }

  if ($key -eq "PORT") {
    return
  }

  Write-Host "Setting $key"
  & $RailwayCommand variable set "$key=$value" --skip-deploys | Out-Null
}

Write-Host "Done. Redeploy Railway after confirming the variables."
