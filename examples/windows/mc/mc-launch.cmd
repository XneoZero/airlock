@echo off
rem Launched by Task Scheduler as SYSTEM: children of sshd get reaped when the
rem SSH session ends, so the JVM must live outside that process tree.
rem
rem "current" is a junction to the active release, so switching versions needs no
rem edit here. Only changing the app root does. Replace the paths below.
rem
rem Heap: keep it well under total RAM. demo/web style side services also count.
cd /d "C:\airlock\apps\mc\current"
if errorlevel 1 (
    echo cannot enter current: %CD%
    exit /b 2
)
set JAR=
for %%f in (fabric-server-*.jar) do set JAR=%%f
if "%JAR%"=="" (
    echo no fabric-server-*.jar in %CD%
    exit /b 3
)
"C:\Program Files\Java\jdk-25\bin\java.exe" -Xms1G -Xmx1536M -jar "%JAR%" nogui