#!/usr/bin/env node
const { spawn } = require('node:child_process');

spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
setInterval(() => undefined, 1_000);
