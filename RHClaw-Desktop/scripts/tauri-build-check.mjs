#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const cwd = process.cwd();

function run(command, args, label) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('node', ['scripts/check-tauri-toolchain.mjs'], 'Tauri toolchain doctor');
run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], 'cargo check');

console.log('\nTauri 构建预检通过。');
