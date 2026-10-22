@echo off
setlocal EnableDelayedExpansion
REM ============================================================
REM  OpenCode desktop TUI launcher - realtime pair for Telegram bot
REM  Usage:
REM    opencode-desktop.cmd                      -> interactive project picker
REM    opencode-desktop.cmd D:\Projects\Foo      -> open given project directly
REM    set OPENCODE_DESKTOP_PORT=4100 && ...     -> different server port
REM    set OPENCODE_BIN_PATH=C:\path\to\opencode.exe && ...  -> custom opencode binary
REM  The Telegram bot watches http://localhost:4097 - keep THIS
REM  window open while coding.
REM ============================================================

if "%OPENCODE_DESKTOP_PORT%"=="" set OPENCODE_DESKTOP_PORT=4097
if "%OPENCODE_PROJECT_DIR%"=="" set "OPENCODE_PROJECT_DIR="
if "%OPENCODE_BIN_PATH%"=="" set "OPENCODE_BIN_PATH=opencode"

echo [1/5] Checking '%OPENCODE_BIN_PATH%' is available...
where "%OPENCODE_BIN_PATH%" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: '%OPENCODE_BIN_PATH%' is not found.
  echo   FIX  : Install OpenCode first, or set OPENCODE_BIN_PATH to the full path, e.g.:
  echo          setx OPENCODE_BIN_PATH "%USERPROFILE%\.opencode\bin\opencode.exe"
  echo          then close ^& reopen this window.
  goto FAIL
)

echo [2/5] Checking server on port %OPENCODE_DESKTOP_PORT%...
set HOLDER_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%OPENCODE_DESKTOP_PORT% " ^| findstr /C:"LISTENING"') do set HOLDER_PID=%%P

echo [3/5] Building project list from the running server...

set MENU_FILE=%TEMP%\ocd-projects.txt
curl -s --max-time 6 "http://127.0.0.1:%OPENCODE_DESKTOP_PORT%/project" -o "%TEMP%\ocd-projects.json"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; try { $j = Get-Content '%TEMP%\ocd-projects.json' -Raw | ConvertFrom-Json; $i=0; foreach($p in $j){ $i++; $w=$p.worktree -replace '/','\'; Write-Output (''+$i+'|'+$w+'|'+($p.name ?? $w)) } } catch { exit 1 }" > "%MENU_FILE%" 2>nul
set MENU_COUNT=0
for /f "usebackq tokens=1 delims=|" %%a in ("%MENU_FILE%") do set /a MENU_COUNT+=1

echo.
echo   Pilih project untuk TUI ini ^(sesi ^& riwayat per project^):
set CHOSEN=
for /f "usebackq tokens=1,2,3 delims=|" %%a in ("%MENU_FILE%") do (
  echo     [%%a] %%c
  echo         %%b
)
if %MENU_COUNT% GTR 0 (
  echo     [M] Path lain - ketik manual
  echo     [Q] Batal
  set /p PICK=Arahkan ke nomor project ^(1-%MENU_COUNT%^, M, Q, Enter=default pertama^):
) else (
  echo   Server tidak memberi daftar project - masukkan path manual.
  echo     [M] Ketik path manual
  echo     [Q] Batal
  set "PICK=M"
)

if /i "%PICK%"=="Q" goto CANCEL
if /i "%PICK%"=="M" goto MANUAL
if "%PICK%"=="" set PICK=1

for /f "usebackq tokens=1,2 delims=|" %%a in ("%MENU_FILE%") do (
  if "%%a"=="%PICK%" set "CHOSEN=%%b"
)
if not defined CHOSEN (
  echo   Pilihan tidak valid: "%PICK%"
  goto FAIL
)
goto HAVE_PROJECT

:MANUAL
set /p CHOSEN=Path project (contoh D:\Coding\portfolio):
if not defined CHOSEN goto FAIL
goto HAVE_PROJECT

:CANCEL
echo Dibatalkan.
endlocal
exit /b 0

:HAVE_PROJECT
echo [4/5] Project dipilih: %CHOSEN%
cd /d "%CHOSEN%" || goto FAIL

echo [5/5] Starting OpenCode desktop TUI on port %OPENCODE_DESKTOP_PORT% ...
if defined HOLDER_PID (
  echo       Server terdeteksi jalan ^(PID %HOLDER_PID%^) - TUI akan ATTACH ke sana.
  "%OPENCODE_BIN_PATH%" attach http://127.0.0.1:%OPENCODE_DESKTOP_PORT%
) else (
  echo       Belum ada server - TUI+server baru dimulai di port ini.
  "%OPENCODE_BIN_PATH%" --port %OPENCODE_DESKTOP_PORT%
)
echo.
echo OpenCode exited.
endlocal
pause
exit /b 0

:FAIL
echo.
endlocal
pause
exit /b 1
