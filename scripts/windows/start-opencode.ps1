<#
.SYNOPSIS
  Start stack OpenCode GLOBAL: serve (hub) + attach TUI + bot (npm run dev).
  Semua client nyambung ke server yang sama. Server & TUI TIDAK dikunci ke
  folder project - mereka jalan global (mengikuti working directory terminal
  asal script ini dijalankan). Bot jalan di folder bot.

.DESCRIPTION
  Model global:
    Bot tele  <--->  opencode serve --port X (hub)  <--->  opencode attach

  Alur:
    1. Cek status port DULU:
         - Ada server hidup      -> stop dulu (stop-opencode.cmd) / attach manual
         - GHOST (PID mati)      -> peringatan; pakai -AutoPort / -Hostname 127.0.0.2
         - Bebas                 -> lanjut
    2. Buka window: [1] opencode serve --port X   [2] opencode attach  [3] npm run dev
    3. Poll health check server sampai siap, baru buka attach + bot.
    4. Bot diberi env OPENCODE_PORT=X agar konek ke port yang benar.
       (Catatan: kalau .env punya OPENCODE_API_URL, itu yang MENANG - samakan manual.)

.PARAMETER Port        Port server (default: OPENCODE_SERVE_PORT > OPENCODE_DESKTOP_PORT > 4591)
.PARAMETER Hostname    Host bind. Default 127.0.0.1. Untuk trik ghost pakai 127.0.0.2.
.PARAMETER BotDir      Folder untuk window bot (default: root repo ini). Alias: -ProjectDir.
.PARAMETER AutoPort    Kalau port ghost, otomatis cari port bebas berikutnya.
.PARAMETER SkipAttach / SkipBot  Jangan buka window attach/bot.

.EXAMPLE
  .\start-opencode.ps1
  .\start-opencode.ps1 -Port 4200 -AutoPort
  .\start-opencode.ps1 -SkipAttach          # hub + bot saja
#>
param(
  [int]$Port = 0,
  [string]$Hostname = "127.0.0.1",
  [Alias('ProjectDir')]
  [string]$BotDir = "",
  [switch]$AutoPort,
  [switch]$SkipAttach,
  [switch]$SkipBot
)

$ErrorActionPreference = 'SilentlyContinue'
$usePort  = $Port
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

# ---- Resolusi port & folder bot default ----
if ($usePort -le 0) {
  if ($env:OPENCODE_SERVE_PORT)       { $usePort = [int]$env:OPENCODE_SERVE_PORT }
  elseif ($env:OPENCODE_DESKTOP_PORT) { $usePort = [int]$env:OPENCODE_DESKTOP_PORT }
  else                                { $usePort = 4591 }
}
if (-not $BotDir) { $BotDir = $repoRoot }

if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Write-Host "  ERROR: 'opencode' tidak ditemukan di PATH." -ForegroundColor Red
  Write-Host "  Instal dulu, atau set OPENCODE_BIN_PATH ke path lengkap opencode.exe." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Start OpenCode GLOBAL  |  port $usePort  |  $Hostname" -ForegroundColor Cyan
Write-Host "  Serve & TUI: global (ikut cwd terminal ini)" -ForegroundColor Cyan
Write-Host "  Bot in     : $BotDir" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# ---- Cek status port ----
function Test-PortState {
  param([int]$p)
  $pat = [regex]::Escape("$p")
  $rows = netstat -ano | Select-String ":$pat\s"
  if (-not $rows) { return 'FREE' }
  foreach ($r in $rows) {
    $cols = ($r.Line -split '\s+') | Where-Object { $_ }
    if ($cols.Count -lt 5) { continue }   # TCP | local | foreign | state | PID
    if ($cols[3] -eq 'LISTENING' -and $cols[4] -match '^\d+$') {
      if (Get-Process -Id ([int]$cols[4]) -ErrorAction SilentlyContinue) { return "LIVE:$($cols[4])" }
      return "GHOST:$($cols[4])"
    }
  }
  return 'STALE'   # hanya sisa TIME_WAIT/ESTABLISHED, listener bebas
}

$state = Test-PortState -p $usePort
switch -Regex ($state) {
  '^LIVE' {
    Write-Host "`n  Port $usePort sudah dipakai server HIDUP (PID $($state.Split(':')[1]))." -ForegroundColor Yellow
    Write-Host "  Opsi: stop dulu (stop-opencode.cmd)  ATAU  langsung attach manual:" -ForegroundColor Yellow
    Write-Host "        opencode attach http://$Hostname`:$usePort" -ForegroundColor White
    exit 1
  }
  '^GHOST' {
    $deadPid = $state.Split(':')[1]
    Write-Host "`n  [GHOST PORT] $usePort dipegang PID $deadPid (sudah mati)." -ForegroundColor Magenta
    if ($AutoPort) {
      $found = $null
      for ($n = $usePort + 1; $n -lt $usePort + 20; $n++) {
        $s = Test-PortState -p $n
        if ($s -eq 'FREE' -or $s -eq 'STALE') { $found = $n; break }
      }
      if ($found) {
        Write-Host "  -AutoPort aktif: pindah ke port $found (cek juga OPENCODE_API_URL di .env kalau bot gagal konek)." -ForegroundColor Yellow
        $usePort = $found
      } else {
        Write-Host "  Tidak ada port bebas di rentang +20. Reboot atau -Hostname 127.0.0.2." -ForegroundColor Red
        exit 2
      }
    } else {
      Write-Host "`n  Opsi:" -ForegroundColor White
      Write-Host "    1. Reboot   2. /Port <nomor lain>   3. /Hostname 127.0.0.2"
      Write-Host "  (atau ulangi dengan /AutoPort)" -ForegroundColor DarkGray
      exit 2
    }
  }
  '^STALE' {
    Write-Host "`n  Port ${usePort}: sisa koneksi lama (TIME_WAIT) - aman dipakai." -ForegroundColor DarkGray
  }
  default {
    Write-Host "`n  Port $usePort bebas. OK." -ForegroundColor Green
  }
}

# ---- Buka window 1: server (global, ikut cwd terminal ini) ----
Write-Host "`n[1/3] Buka window SERVER:  opencode serve --port $usePort (global) ..." -ForegroundColor Green
$serverCmd = '$Host.UI.RawUI.WindowTitle = ''OC-SERVE-' + $usePort + '''; opencode serve'
if ($Hostname -and $Hostname -ne '0.0.0.0') { $serverCmd += ' --hostname ' + $Hostname }
if ($env:OPENCODE_BIN_PATH) { $serverCmd = $serverCmd -replace '^.*opencode serve', ($env:OPENCODE_BIN_PATH + ' serve') }
$serverCmd += ' --port ' + $usePort
Start-Process powershell -ArgumentList @('-NoExit', '-Command', $serverCmd)
Write-Host "     Window baru dibuka." -ForegroundColor DarkGray

# ---- Poll health check ----
Write-Host "`n[2/3] Menunggu server siap (health check)... " -ForegroundColor Green
$ready = $false
for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Milliseconds 750
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$usePort/global/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    try {
      $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$usePort/health" -UseBasicParsing -TimeoutSec 2
      if ($r2.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
}
if ($ready) {
  Write-Host "     Server SIAP di http://127.0.0.1:$usePort" -ForegroundColor Green
} else {
  Write-Host "     Server belum balas. Attach/bot tetap dicoba." -ForegroundColor Yellow
}

# ---- Buka window 2: attach TUI (global, ikut cwd terminal ini) ----
if (-not $SkipAttach) {
  Write-Host "`n[3/3] Buka window ATTACH TUI (global):  opencode attach http://$Hostname`:$usePort ..." -ForegroundColor Green
  $attachCmd = '$Host.UI.RawUI.WindowTitle = ''OC-TUI-' + $usePort + '''; opencode attach http://' + $Hostname + ':' + $usePort
  if ($env:OPENCODE_BIN_PATH) { $attachCmd = $attachCmd -replace 'opencode attach', ($env:OPENCODE_BIN_PATH + ' attach') }
  Start-Process powershell -ArgumentList @('-NoExit', '-Command', $attachCmd)
}

# ---- Buka window 3: bot ----
if (-not $SkipBot) {
  Write-Host "`n[3/3] Buka window BOT (npm run dev) di $BotDir ..." -ForegroundColor Green
  $botCmd = '$Host.UI.RawUI.WindowTitle = ''OC-BOT-' + $usePort + '''; $env:OPENCODE_PORT = ' + $usePort + '; npm run dev'
  Start-Process powershell -ArgumentList @('-NoExit', '-Command', $botCmd) -WorkingDirectory $BotDir
}

Write-Host ""
Write-Host "  Semua window terbuka. Stop aman:  stop-opencode.cmd" -ForegroundColor White
Write-Host "  (matikan bot + attach dulu, server terakhir - hindari ghost port)" -ForegroundColor DarkGray
Write-Host "==================================================`n" -ForegroundColor Cyan
