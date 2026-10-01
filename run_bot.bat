@echo off
SET PORT=%~1
IF "%PORT%"=="" SET PORT=50694

SET BOTNAME=%~2
IF "%BOTNAME%"=="" SET BOTNAME=SpeedBot

:loop
echo Starting bot %BOTNAME% on localhost:%PORT%...
node --max-old-space-size=4096 index.js localhost %PORT% %BOTNAME% >> bot_debug.log 2>&1
echo Bot crashed! Restarting in 5 seconds...
timeout /t 5
goto loop
