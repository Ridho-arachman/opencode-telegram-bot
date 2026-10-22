<#
.SYNOPSIS
  Stop stack OpenCode (serve + attach TUI + bot) dengan urutan yang BENAR,
  untuk menghindari bug ghost-port Windows (zombie self-loopback SSE).

.DESCRIPTION
  Bug resmi (anomalyco/opencode #32932, #9859, #22198):
  kalau `opencode serve` dimatikan paksa SELAGIT ada koneksi SSE terbuka,
  Windows menyisakan koneksi loopback ESTABLISHED yang tidak pernah dapat
  FIN/RST -> listening socket terkunci ke PID yang sudah mati ("ghost"),
  dan hanya reboot yang membersihkannya.

  Kenapa urutan ini penting?
    1. Bot   (node dist/index.js)  dimatikan dulu  -> socket SSE client ditutup (kirim FIN)
    2. Attach (opencode attach)     dimatikan dulu  -> socket SSE client ditutup (kirim FIN)
    3. Server (opencode serve)      dimatikan TERAKHIR -> listener tutup bersih, tanpa zombie

.EXAMPLE
  .\stop-opencode.ps1                  # pakai port default (env > 4591)
  .\stop-opencode.ps1 -Port 4200
#>
param(
  [int]$Port = 0
)

$ErrorActionPreference = 'SilentlyContinue'

# ---- Resolusi port: -Port > OPENCODE_SERVE_PORT > OPENCODE_DESKTOP_PORT > 4591 ----
if ($Port -le 0) {
  if ($env:OPENCODE_SERVE_PORT)        { $Port = [int]$env:OPENCODE_SERVE_PORT }
  elseif ($env:OPENCODE_DESKTOP_PORT)  { $Port = [int]$env:OPENCODE_DESKTOP_PORT }
  else                                 { $Port = 4591 }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Stop OpenCode stack (port $Port) - urutan aman" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# ---- Kumpulkan proses berdasarkan pola command line ----
$portPat = [regex]::Escape("$Port")
$procs   = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }

$isOc      = { param($p) $p.CommandLine -match 'opencode' }
$isThisBot = { param($p) $p.Name -eq 'node.exe' -and $p.CommandLine -match 'dist[\/]index\.js' }

# Attach/TUI & server yang menyentuh port ini saja (jangan sampai bunuh
# stack opencode lain yang lagi jalan di port berbeda).
$attachs = @($procs | Where-Object {
  (& $isOc $_) -and $_.CommandLine -match 'attach' -and $_.CommandLine -match $portPat
})
$bots = @($procs | Where-Object { & $isThisBot $_ })
# TUI yang host server sendiri (`opencode --port X`) ikut tertangkap di sini,
# karena polanya cocok dengan "--port X".
$servers = @($procs | Where-Object {
  (& $isOc $_) -and $_.CommandLine -match "--port[=\s]+$portPat"
})

function Stop-OcProcs {
  param([string]$Label, [object[]]$Targets)
  if ($Targets.Count -eq 0) {
    Write-Host ("  {0,-16}: (tidak ada)" -f $Label)
    return
  }
  $ids = @($Targets | ForEach-Object { $_.ProcessId })
  Write-Host ("  {0,-16}: {1}" -f $Label, (($ids | ForEach-Object { "PID $_" }) -join ', ')) -ForegroundColor Yellow
  foreach ($t in $Targets) {
    $cmd = ($t.CommandLine -replace '\s+', ' ')
    if ($cmd.Length -gt 80) { $cmd = $cmd.Substring(0, 80) + '...' }
    Write-Host ("      -> PID {0}  {1}" -f $t.ProcessId, $cmd) -ForegroundColor DarkGray
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`n[1/4] Matikan BOT dulu (client SSE #1)..." -ForegroundColor Green
Stop-OcProcs -Label "Bot (node)" -Targets $bots

Write-Host "`n[2/4] Matikan ATTACH TUI (client SSE #2)..." -ForegroundColor Green
Stop-OcProcs -Label "Attach TUI" -Targets $attachs

# Beri waktu FIN/RST dari client tersebar sebelum server mati
if ($bots.Count -gt 0 -or $attachs.Count -gt 0) {
  Write-Host "`n   (Tunggu 2 detik agar socket client menutup bersih...)" -ForegroundColor DarkGray
  Start-Sleep -Seconds 2
}

Write-Host "`n[3/4] Matikan SERVER (terakhir, biar listener tutup bersih)..." -ForegroundColor Green
Stop-OcProcs -Label "Serve" -Targets $servers

# ---- Verifikasi akhir: apakah port benar-benar bersih? ----
Write-Host "`n[4/4] Verifikasi port $Port ..." -ForegroundColor Green
Start-Sleep -Milliseconds 800

$rows = netstat -ano | Select-String ":$portPat\s"
if (-not $rows) {
  Write-Host "`n  Port $Port BERSIH. Ghost port tidak terbentuk. OK." -ForegroundColor Green
  Write-Host "==================================================`n" -ForegroundColor Cyan
  exit 0
}

Write-Host ""
Write-Host "  Sisa koneksi di port $Port :" -ForegroundColor Yellow
$ghostFound = $false
foreach ($r in $rows) {
  $cols = ($r.Line -split '\s+') | Where-Object { $_ }
  if ($cols.Count -lt 5) { continue }   # netstat: TCP | local | foreign | state | PID
  $state  = $cols[3]
  $pidRaw = $cols[4]
  if ($state -eq 'LISTENING' -and $pidRaw -match '^\d+$') {
    if (Get-Process -Id ([int]$pidRaw) -ErrorAction SilentlyContinue) {
      Write-Host ("    {0,-10} {1,-21} PID {2}   (masih hidup!)" -f $state, $cols[1], $pidRaw) -ForegroundColor Red
    } else {
      Write-Host ("    {0,-10} {1,-21} PID {2}   <-- GHOST (process sudah mati)" -f $state, $cols[1], $pidRaw) -ForegroundColor Magenta
      $ghostFound = $true
    }
  } else {
    Write-Host ("    {0,-10} {1,-21} PID {2}   (bukan listener; akan hilang sendiri)" -f $state, $cols[1], $pidRaw) -ForegroundColor DarkGray
  }
}

if ($ghostFound) {
  Write-Host ""
  Write-Host "  [GHOST PORT DETEKSI] Listening socket dipegang PID mati -" -ForegroundColor Magenta
  Write-Host "  tidak bisa dibunuh via taskkill (prosesnya memang sudah tidak ada)." -ForegroundColor Magenta
  Write-Host ""
  Write-Host "  Opsi penyelesaian:" -ForegroundColor White
  Write-Host "    1. Reboot komputer  (satu-satunya yang membersihkan tuntas)."
  Write-Host "    2. Lanjut pakai port lain:  start-opencode.cmd /Port <nomor>"
  Write-Host "    3. Trik TANPA reboot: serve di loopback lain yang tidak bentrok:"
  Write-Host "         start-opencode.cmd /Hostname 127.0.0.2    (attach otomatis ikut)"
  Write-Host ""
  Write-Host "  Catatan: jangan matikan server SELAGI attach/bot masih nyambung -" -ForegroundColor DarkGray
  Write-Host "  itu penyebab utama zombie ini terbentuk." -ForegroundColor DarkGray
  Write-Host "==================================================`n" -ForegroundColor Cyan
  exit 2
}

Write-Host "`n  Port $Port tidak di-LISTENING lagi (sisa koneksi akan hilang sendiri)." -ForegroundColor Green
Write-Host "==================================================`n" -ForegroundColor Cyan
exit 0
