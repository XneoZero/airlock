@echo off
rem cwd = the freshly unpacked version dir (deployer runs install with cwd=version).
rem
rem A Minecraft world is state, not code. Publishing a new version unpacks a clean
rem directory, so keep the world outside releases/ and only link to it here.
rem Same for server.properties: one copy in shared\ survives every publish.
set MCROOT=C:\airlock\apps\mc
if not exist "%MCROOT%\shared" mkdir "%MCROOT%\shared"
if not exist "%MCROOT%\shared\world" mkdir "%MCROOT%\shared\world"
if exist "world" rmdir "world" >nul 2>&1
mklink /J "world" "%MCROOT%\shared\world" >nul
>eula.txt echo eula=true
if exist "%MCROOT%\shared\server.properties" copy /y "%MCROOT%\shared\server.properties" "server.properties" >nul
exit /b 0