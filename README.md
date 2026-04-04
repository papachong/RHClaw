# RHClaw

[中文](README.zh-CN.md) | English

RHClaw makes shrimp farming effortless — one-click fully offline installation, automatic OpenClaw configuration, and WeChat Mini Program integration. Secure, reliable, multi-agent collaboration with shared memory. Start your private lobster army today! 🦐🦐

## Current Modules

- `RHClaw-Desktop/`: Desktop client for packaging, installing, configuring, and managing the OpenClaw multi-platform offline bundle. Built with Tauri + React.
- `RHClaw-Channel/`: An OpenClaw Gateway channel plugin that bridges the RHClaw control-plane protocol into the OpenClaw runtime.

## Quick Start

```bash
cd RHClaw-Desktop
cp .env.example .env.local
npm install
npm run desktop:dev
```

By default, the workspace assumes a local API service at `http://localhost:3000/api/v1`. If your API runs elsewhere, update `.env.local` before starting Vite.

## Desktop And Channel

`RHClaw-Desktop/` and `RHClaw-Channel/` are designed to work together in the same public workspace.

- Desktop can consume a local Channel source checkout through `RHOPENCLAW_CHANNEL_ROOT`.
- Desktop full-offline packaging can also consume a prebuilt Channel `.tgz` through `RHOPENCLAW_CHANNEL_PACKAGE_PATH`.
- The current npm package spec remains `@rhopenclaw/rhclaw-channel` for compatibility with the existing Desktop installer, local validation logic, and full-offline packaging flow.
- If the package scope is rebranded later, the Desktop frontend, Tauri runtime checks, Rust-side install receipts, and packaging scripts must be updated together in one coordinated change — modifying only the Channel metadata is not sufficient.
