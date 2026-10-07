# ==============================================================================
# Global Docker Stack Setup Script for Windows (PowerShell)
# ==============================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "   Setting up Global Docker Stack (Windows)           " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Prerequisites
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Cyan

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $dockerVer = docker --version
    Write-Host "  [+] Docker is installed: $dockerVer" -ForegroundColor Green
} else {
    Write-Host "  [-] Docker is NOT installed. Please install Docker Desktop from https://www.docker.com/products/docker-desktop/" -ForegroundColor Red
    Exit 1
}

try {
    docker info > $null 2>&1
    Write-Host "  [+] Docker daemon is running." -ForegroundColor Green
} catch {
    Write-Host "  [!] Docker daemon is not running. Please launch Docker Desktop and run this script again." -ForegroundColor Yellow
    Exit 1
}

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = node --version
    $nodeMajor = [int](node -e "console.log(process.versions.node.split('.')[0])")
    if ($nodeMajor -ge 18) {
        Write-Host "  [+] Node.js is installed: $nodeVer (>= 18 LTS)" -ForegroundColor Green
    } else {
        Write-Host "  [-] Node.js $nodeVer is too old. Please upgrade to Node.js 18 LTS, 20 LTS, or 22+ from https://nodejs.org/" -ForegroundColor Red
        Exit 1
    }
} else {
    Write-Host "  [-] Node.js is NOT installed. Please install Node.js (18 LTS, 20 LTS, or 22+) from https://nodejs.org/" -ForegroundColor Red
    Exit 1
}

if (Get-Command yarn -ErrorAction SilentlyContinue) {
    $yarnVer = yarn --version
    Write-Host "  [+] Yarn is installed: $yarnVer" -ForegroundColor Green
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmVer = npm --version
    Write-Host "  [+] npm is installed: $npmVer" -ForegroundColor Green
}

# 2. Setup .env file
Write-Host ""
Write-Host "[2/5] Setting up environment configuration (.env)..." -ForegroundColor Cyan
$envFile = Join-Path $ScriptDir ".env"
$envExample = Join-Path $ScriptDir ".env.example"

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "  [+] Created .env from .env.example" -ForegroundColor Green
        Write-Host "  [!] IMPORTANT: Please open .env and set your TS_AUTHKEY." -ForegroundColor Yellow
    } else {
        Write-Host "  [-] .env.example not found." -ForegroundColor Red
    }
} else {
    Write-Host "  [+] .env already exists." -ForegroundColor Green
    $envContent = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
    if ($envContent -match "tskey-auth-your-key-here" -or $envContent -match "TS_AUTHKEY=\s*`r?`n" -or $envContent -match 'TS_AUTHKEY=(""|'''')') {
        Write-Host "  [!] TS_AUTHKEY appears unset or default in .env. Please set your key for Tailscale HTTPS." -ForegroundColor Yellow
    }
}

# 3. Create required folders
Write-Host ""
Write-Host "[3/5] Initializing workspace directories..." -ForegroundColor Cyan
$folders = @("html", "webapps", "projects")
foreach ($folder in $folders) {
    $dirPath = Join-Path $ScriptDir $folder
    if (-not (Test-Path $dirPath)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
    }
    $keepFile = Join-Path $dirPath ".gitkeep"
    if (-not (Test-Path $keepFile)) {
        New-Item -ItemType File -Path $keepFile -Force | Out-Null
    }
}
Write-Host "  [+] html\, webapps\, and projects\ ready." -ForegroundColor Green

# 4. Install PowerShell Profile Shortcuts
Write-Host ""
Write-Host "[4/5] Installing global PowerShell shortcuts..." -ForegroundColor Cyan

$ProfilePath = $PROFILE.CurrentUserCurrentHost
if (-not $ProfilePath) {
    $ProfilePath = $PROFILE
}

$ProfileDir = Split-Path -Parent $ProfilePath
if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}
if (-not (Test-Path $ProfilePath)) {
    New-Item -ItemType File -Path $ProfilePath -Force | Out-Null
}

$MarkerStart = "# >>> GLOBAL_DOCKER_STACK_START >>>"
$MarkerEnd   = "# <<< GLOBAL_DOCKER_STACK_END <<<"

$NormalizedScriptDir = $ScriptDir.Replace("\", "/")

$ShortcutsBlock = @"
$MarkerStart
# --- Global Docker Stack Shortcuts ---
`$env:DOCKER_GLOBAL_DIR = "$NormalizedScriptDir"

function dwar { param([string]`$path = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/deploy-war.cjs" `$path }
function dweb { param([string]`$path = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/deploy-web.cjs" `$path }
function dzip { param([string]`$path = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/deploy-zip.cjs" `$path }
function dall { param([string]`$path = ".") dwar `$path; dzip `$path }
function drm  { param([string]`$name = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/remove-project.cjs" `$name }
function d-rm { param([string]`$name = ".") drm `$name }
function dstop { param([string]`$name = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/manage-project.cjs" "stop" `$name }
function d-stop { param([string]`$name = ".") dstop `$name }
function dstart { param([string]`$name = ".") node "`$env:DOCKER_GLOBAL_DIR/scripts/manage-project.cjs" "start" `$name }
function d-start { param([string]`$name = ".") dstart `$name }

function d-up { Push-Location "`$env:DOCKER_GLOBAL_DIR"; docker compose up -d; Pop-Location }
function d-down { Push-Location "`$env:DOCKER_GLOBAL_DIR"; docker compose down; Pop-Location }
function d-restart { Push-Location "`$env:DOCKER_GLOBAL_DIR"; docker compose restart; Pop-Location }
function d-ps { docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" }
function d-logs { Push-Location "`$env:DOCKER_GLOBAL_DIR"; docker compose logs -f; Pop-Location }
$MarkerEnd
"@

$ProfileContent = Get-Content -Path $ProfilePath -Raw -ErrorAction SilentlyContinue
if ($null -eq $ProfileContent) { $ProfileContent = "" }

# Remove existing block if present
$Pattern = [regex]::Escape($MarkerStart) + "[\s\S]*?" + [regex]::Escape($MarkerEnd)
$UpdatedProfile = [regex]::Replace($ProfileContent, $Pattern, "").Trim()

$UpdatedProfile = $UpdatedProfile + "`r`n`r`n" + $ShortcutsBlock + "`r`n"
Set-Content -Path $ProfilePath -Value $UpdatedProfile -Encoding utf8

Write-Host "  [+] Injected shortcuts into PowerShell Profile: $ProfilePath" -ForegroundColor Green

# 5. Start Docker Containers
Write-Host ""
Write-Host "[5/5] Starting Docker containers..." -ForegroundColor Cyan
Push-Location $ScriptDir
try {
    docker compose up -d
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "   Setup Completed Successfully!                      " -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "To activate the shortcuts in your current PowerShell session, run:" -ForegroundColor Yellow
Write-Host "  . `$PROFILE" -ForegroundColor Cyan
Write-Host ""
Write-Host "Available Shortcuts:" -ForegroundColor White
Write-Host "  dweb      Deploy Web Frontend from current directory -> https://<your-app-domain>.ts.net/<project>/" -ForegroundColor Green
Write-Host "  dwar      Deploy Java WAR from current directory     -> https://<your-qa-domain>.ts.net/<app>/" -ForegroundColor Green
Write-Host "  dzip      Deploy ZIP release from current directory" -ForegroundColor Green
Write-Host "  dall      Deploy both WAR and Web frontend" -ForegroundColor Green
Write-Host "  d-up      Start all global Docker containers" -ForegroundColor Green
Write-Host "  d-down    Stop all global Docker containers" -ForegroundColor Green
Write-Host "  d-ps      View all running containers" -ForegroundColor Green
Write-Host "  d-logs    Live stream container logs" -ForegroundColor Green
Write-Host ""
