@echo off
REM ============================================================
REM  Start stack OpenCode GLOBAL: serve (hub) + attach TUI + bot.
REM  Serve & TUI jalan global (tidak dikunci folder project),
REM  semua client nyambung ke server yang sama.
REM  Otomatis cek port dulu (deteksi ghost port Windows).
REM
REM  Usage:
REM    start-opencode.cmd                      -> port default (OPENCODE_SERVE_PORT > 4591)
REM    start-opencode.cmd /Port 4200
REM    start-opencode.cmd /AutoPort            -> ghost: pindah port bebas otomatis
REM    start-opencode.cmd /Hostname 127.0.0.2  -> trik ghost: bind loopback lain
REM    start-opencode.cmd /SkipAttach          -> hub + bot saja (tanpa TUI)
REM ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-opencode.ps1" %*
endlocal
