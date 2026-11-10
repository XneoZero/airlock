@echo off
rem Start the app outside the sshd process tree: children of sshd get reaped when
rem the SSH session ends, so hand the process to Task Scheduler instead.
rem
rem %CD% is the version dir, because deployer.json sets "cwd": "current" for this
rem command. Using %CD% instead of an absolute path means changing the app root
rem (the "root" field) needs no edit here.
rem
rem Replace <app> with the app id from deployer.json, and replace the node path
rem below with the real one on your box (run: where node).
set APP=<app>
schtasks /create /tn airlock-%APP%-start /tr "C:\nodejs\node.exe %CD%\server.mjs" /sc once /st 00:00 /ru SYSTEM /f >nul 2>&1
if errorlevel 1 exit /b 2
schtasks /run /tn airlock-%APP%-start >nul 2>&1
if errorlevel 1 exit /b 3
exit /b 0