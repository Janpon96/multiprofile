@echo off
title MultiProfile Studio PC
cd /d "%~dp0"

echo ========================================================
echo        MultiProfile Studio PC - Khoi Dong 1-Click
echo ========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js tren may tinh.
    echo Vui long cai dat Node.js LTS tu https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [INFO] Dang cai dat thu vien lan dau tien...
    call npm install
    if errorlevel 1 (
        echo [LOI] Cai dat dependencies that bai.
        pause
        exit /b 1
    )
)

if not exist "apps\desktop\dist\main\electron-main.js" (
    echo [INFO] Dang bien dich ma nguon TypeScript...
    call npm run build
    if errorlevel 1 (
        echo [LOI] Bien dich that bai.
        pause
        exit /b 1
    )
)

echo [INFO] Dang khoi chay MultiProfile Studio (Electron)...
start "" "node_modules\electron\dist\electron.exe" "apps\desktop"
exit /b 0