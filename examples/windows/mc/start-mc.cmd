@echo off
rem deployer.json calls this with cwd=current; it only registers and runs the task.
schtasks /create /tn airlock-mc-start /tr "C:\airlock\bin\mc-launch.cmd" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn airlock-mc-start >nul 2>&1
if errorlevel 1 exit /b 3
exit /b 0