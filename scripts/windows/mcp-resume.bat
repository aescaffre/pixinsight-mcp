@echo off
rem Resume the PixInsight MCP watcher: delete the 'pause' sentinel.
set "B=%USERPROFILE%\.pixinsight-mcp\bridge"
if exist "%B%\pause" (
  del "%B%\pause"
  echo Watcher RESUMED.
) else (
  echo The watcher was not paused.
)
if /i not "%~1"=="/q" pause
