@echo off
cd /d "%~dp0"
echo Starting AGBS LIBRARY...
echo.
echo Keep this window open while using the app.
echo Open http://localhost:3000 in your browser.
echo.
"C:\Users\HP\AppData\Local\OpenAI\Codex\bin\node.exe" server.js
pause
