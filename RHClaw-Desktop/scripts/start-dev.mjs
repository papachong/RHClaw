#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

const command = isWindows ? 'cmd.exe' : 'bash';
const args = isWindows
  ? ['/d', '/s', '/c', join(__dirname, 'start-dev-windows.cmd')]
  : [join(__dirname, 'start-dev.sh')];

const child = spawn(command, args, {
  cwd: join(__dirname, '..'),
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error('[ERROR] Failed to start desktop dev script:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
