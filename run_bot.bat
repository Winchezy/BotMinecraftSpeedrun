@echo off
:loop
node --max-old-space-size=4096 index.js localhost 25565 SpeedBot >> bot_debug.log 2>&1
echo Bot crashed! Restarting in 5 seconds...
timeout /t 5
goto loop
