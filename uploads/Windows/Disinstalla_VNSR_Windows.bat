@echo off
chcp 65001 >nul 2>&1
title VNSR Label - Disinstallazione Programma (Windows)
color 0C

echo ======================================================================
echo   VNSR LABEL - DISINSTALLAZIONE DAL COMPUTER (WINDOWS 10 / 11)
echo ======================================================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\VNSR_Gestionale"
set "DESKTOP_DIR=%USERPROFILE%\Desktop"
set "STARTMENU_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\VNSR Label"

echo [1/4] Arresto di eventuali processi VNSR Server in esecuzione...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*VNSR_Gestionale*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [2/4] Rimozione collegamenti dal Desktop e dal Menu Start...
if exist "%DESKTOP_DIR%\VNSR Label.lnk" del /f /q "%DESKTOP_DIR%\VNSR Label.lnk"
if exist "%DESKTOP_DIR%\Disinstalla VNSR.lnk" del /f /q "%DESKTOP_DIR%\Disinstalla VNSR.lnk"
if exist "%STARTMENU_DIR%" rmdir /s /q "%STARTMENU_DIR%"

echo [3/4] Rimozione voce dal Registro App Installate di Windows...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VNSR_Label_Management" /f >nul 2>&1

echo [4/4] Rimozione file di programma da %INSTALL_DIR%...
if exist "%INSTALL_DIR%" (
    cd /d "%TEMP%"
    rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
)

echo.
echo ======================================================================
echo   DISINSTALLAZIONE COMPLETATA CON SUCCESSO!
echo   VNSR Label e tutti i relativi componenti sono stati rimossi.
echo ======================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('VNSR Label è stato disinstallato completamente dal computer.', 'VNSR Label - Disinstallazione Completata', 'OK', 'Information')" >nul 2>&1

timeout /t 3 >nul
exit /b 0
