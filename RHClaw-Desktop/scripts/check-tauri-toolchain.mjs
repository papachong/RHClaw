#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();

function getTauriCliCommand() {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd exec -- tauri --version'],
    };
  }

  const localBin = path.join(cwd, 'node_modules', '.bin', 'tauri');
  if (fs.existsSync(localBin)) {
    return {
      command: localBin,
      args: ['--version'],
    };
  }

  return {
    command: 'npm',
    args: ['exec', '--', 'tauri', '--version'],
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    return {
      ok: false,
      detail: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    };
  }

  return {
    ok: true,
    detail: (result.stdout || result.stderr || 'ok').trim(),
  };
}

function checkFile(relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  return {
    ok: fs.existsSync(absolutePath),
    detail: absolutePath,
  };
}

const checks = [
  { label: 'cargo', ...run('cargo', ['--version']) },
  { label: 'rustc', ...run('rustc', ['--version']) },
  { label: 'rustup', ...run('rustup', ['--version']) },
  (() => {
    const tauriCli = getTauriCliCommand();
    return { label: 'tauri-cli', ...run(tauriCli.command, tauriCli.args) };
  })(),
  { label: 'src-tauri/Cargo.toml', ...checkFile('src-tauri/Cargo.toml') },
  { label: 'src-tauri/tauri.conf.json', ...checkFile('src-tauri/tauri.conf.json') },
];

console.log('RHOpenClaw Desktop · Tauri Toolchain Doctor');
console.log('='.repeat(48));
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.label}: ${item.detail}`);
}

const failed = checks.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\n检测失败：共 ${failed.length} 项未通过。`);
  process.exit(1);
}

console.log('\n检测通过：Rust / Tauri 打包工具链已就绪。');
