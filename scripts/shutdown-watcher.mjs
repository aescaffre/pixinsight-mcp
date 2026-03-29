#!/usr/bin/env node
// Signal the PixInsight MCP watcher to shut down gracefully.
// The watcher checks for this sentinel file and exits its polling loop.
// After shutdown, PixInsight returns to normal interactive mode.

import fs from 'fs';
import path from 'path';
import os from 'os';

const bridgeDir = path.join(os.homedir(), '.pixinsight-mcp', 'bridge');
const shutdownFile = path.join(bridgeDir, 'shutdown');

fs.writeFileSync(shutdownFile, new Date().toISOString());
console.log('Shutdown signal sent to PixInsight watcher.');
console.log('The watcher will exit within ~500ms, returning UI control to PixInsight.');
