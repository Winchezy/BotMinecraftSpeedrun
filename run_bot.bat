@echo off
rem Lance le bot sur un monde ouvert en LAN depuis Minecraft.
rem Usage : run_bot.bat <PORT> [NomDuBot]   (port affiche dans le chat apres "Ouvrir au LAN")
set PORT=%1
if "%PORT%"=="" set /p PORT=Port du monde LAN (affiche dans le chat Minecraft) :
if "%PORT%"=="" (
    echo Aucun port indique. Ouvrez votre monde au LAN puis relancez.
    exit /b 1
)
set NAME=%2
if "%NAME%"=="" set NAME=SpeedBot
:loop
node --max-old-space-size=4096 index.js localhost %PORT% %NAME% >> bot_debug.log 2>&1
echo Bot crashed! Restarting in 5 seconds...
timeout /t 5
goto loop
