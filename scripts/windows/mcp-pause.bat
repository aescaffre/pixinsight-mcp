@echo off
rem Pause the PixInsight MCP watcher: create the 'pause' sentinel in the bridge folder.
rem While it exists the watcher runs no command (they stay queued) and PixInsight stays usable.
set "B=%USERPROFILE%\.pixinsight-mcp\bridge"
if not exist "%B%" mkdir "%B%"
echo pause> "%B%\pause"
echo Watcher PAUSED. Queued commands will run after mcp-resume.bat.
if /i not "%~1"=="/q" pause
