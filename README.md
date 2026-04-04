# RHClaw

RHClaw is the public open-source workspace for the RHClaw desktop client and related components.

## Current Scope

The current public modules are:

- `RHClaw-Desktop/`, a Tauri + React desktop application used to bootstrap a local OpenClaw runtime, inspect local status, and manage desktop-side workflows.
- `RHClaw-Channel/`, an OpenClaw Gateway channel plugin that bridges the RHClaw control-plane protocol into the OpenClaw runtime.

## Quick Start

```bash
cd RHClaw-Desktop
cp .env.example .env.local
npm install
npm run desktop:dev
```

By default, the public workspace assumes a local API service at `http://localhost:3000/api/v1` during development. If your API runs elsewhere, update `.env.local` before starting Vite.

## Notes

- The private source repository remains read-only during the open-source migration.
- Release assets, signing keys, and internal deployment infrastructure are intentionally excluded from this repository.
- Some packaging scripts still require explicit environment variables when you build or publish outside local development.
- The Channel plugin open-source migration plan is tracked in `docs/RHClaw-Channel开源执行计划.md`.

## Desktop And Channel

`RHClaw-Desktop/` and `RHClaw-Channel/` are designed to work together in the public workspace.

- Desktop can consume a local Channel source checkout through `RHOPENCLAW_CHANNEL_ROOT`.
- Desktop full-offline packaging can also consume a prebuilt Channel `.tgz` through `RHOPENCLAW_CHANNEL_PACKAGE_PATH`.
- The current npm package spec remains `@rhopenclaw/rhclaw-channel` for compatibility with the existing Desktop installer, local validation logic, and full-offline packaging flow.
- If the package scope is rebranded later, the Desktop frontend, Tauri runtime checks, Rust-side install receipts, and packaging scripts must be updated together in one coordinated change.
