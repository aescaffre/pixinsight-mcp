@echo off
rem Stop the PixInsight MCP watcher gracefully: create the 'shutdown' sentinel
rem (same as scripts/shutdown-watcher.mjs, without needing Node). PixInsight returns
rem to normal interactive mode within about a second.
set "B=%USERPROFILE%\.pixinsight-mcp\bridge"
if not exist "%B%" mkdir "%B%"
echo %DATE% %TIME%> "%B%\shutdown"
echo Shutdown signal sent to the PixInsight watcher.
if /i not "%~1"=="/q" pause
