@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================================
echo   知乎备份 · 本地断点续传同步工具（不消耗 Apify 额度）
echo ========================================================
echo.
node scripts/local-sync.mjs --type=upvotes
echo.
pause
