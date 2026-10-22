@echo off
REM ============================================================
REM  Stop stack OpenCode (serve + attach + bot) dengan urutan aman.
REM  Urutan penting: BOT & ATTACH dimatikan DULU, server TERAKHIR,
REM  supaya tidak terbentuk ghost port Windows (bug resmi opencode).
REM
REM  Usage:
REM    stop-opencode.cmd                  -> port default (OPENCODE_SERVE_PORT > 4591)
REM    stop-opencode.cmd -Port 4200       -> port tertentu
REM    set OPENCODE_SERVE_PORT=4200 && stop-opencode.cmd
REM ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-opencode.ps1" %*
endlocal
