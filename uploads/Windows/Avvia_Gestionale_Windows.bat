@echo off
chcp 65001 >nul 2>&1
title VNSR Label - Auto-Updater e Server Gestionale
cd /d "%~dp0"
set VNSR_OPEN_BROWSER=1
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [VNSR Auto-Updater] Controllo aggiornamenti sul database prima dell'apertura...
    python updater.py --check-and-apply
    python server.py
    goto :eof
)
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [VNSR Auto-Updater] Controllo aggiornamenti sul database prima dell'apertura...
    py -3 updater.py --check-and-apply
    py -3 server.py
    goto :eof
)
start "" "%~dp0index.html"
