<div align="center">

<img src="assets/logo.png" alt="RHClaw Logo" width="120" />

# RHClaw

### 您的私有 AI 龙虾军团 🦐🦐

[![Build](https://img.shields.io/badge/Build-Passing-brightgreen?style=flat-square)](https://github.com/papachong/RHClaw/actions)
[![Release](https://img.shields.io/badge/Release-v1.0.1-blue?style=flat-square)](https://github.com/papachong/RHClaw/releases)
[![License](https://img.shields.io/badge/License-MIT-informational?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-9cf?style=flat-square)](https://rhclaw.ruhooai.com)
[![Website](https://img.shields.io/badge/Website-rhclaw.ruhooai.com-orange?style=flat-square)](https://rhclaw.ruhooai.com)

**一键养虾，全自动本地安装、配置官方OpenClaw，微信小程序打通。安全可靠，多虾协作，大脑共享，开始你的私有龙虾军团之旅吧！**

[下载桌面端](https://rhclaw.ruhooai.com) · [快速开始](#快速开始) · [English](README.md)

</div>

---

## 当前模块

- `RHClaw-Desktop/`：OpenClaw多平台离线包打包、安装、配置和管理的客户端。基于 Tauri + React 构建的桌面应用。
- `RHClaw-Channel/`：OpenClaw Gateway 渠道插件，将 RHClaw 控制面协议桥接到 OpenClaw 运行时。

## 快速开始

```bash
cd RHClaw-Desktop
cp .env.example .env.local
npm install
npm run desktop:dev
```

默认配置假设本地 API 服务运行在 `http://localhost:3000/api/v1`。如果你的 API 地址不同，请在启动 Vite 前修改 `.env.local`。

## Desktop 与 Channel 的联动关系

`RHClaw-Desktop/` 和 `RHClaw-Channel/` 设计为在同一公开工作区中协同使用：

- Desktop 可通过 `RHOPENCLAW_CHANNEL_ROOT` 直接消费 Channel 本地签出源码。
- Desktop 全量离线打包也可通过 `RHOPENCLAW_CHANNEL_PACKAGE_PATH` 消费预构建的 Channel `.tgz` 包。
- 当前 npm 包名保留为 `@rhopenclaw/rhclaw-channel`，以兼容现有的 Desktop 安装器、本地校验逻辑和全量离线打包链路。
- 若后续需要更换 npm scope，必须同步修改 Desktop 前端、Tauri 运行时校验、Rust 侧安装凭据以及打包脚本，需作为一次协调变更统一完成，不能单独修改 Channel 侧元数据。

## GitHub Actions 构建与发布（Desktop）

仓库已提供 Desktop 自动化流程：`.github/workflows/desktop-package.yml`。

- 手动触发：在 GitHub Actions 运行 `RHClaw Desktop Package`（`workflow_dispatch`）。
- 标签触发：推送 `v1.0.0` 或 `desktop-v1.0.0` 这类 tag 后自动进入构建与发布流程。
- 构建平台：macOS arm64、macOS x64、Windows x64。
- 构建产物：会上传为 workflow artifacts（`rhclaw-desktop-*-bundle`）。
- 发布报告：会上传为 `rhclaw-desktop-release-report`。
- GitHub Release 发布：
	- tag 触发时自动发布。
	- 手动触发时可通过 `publish_github_release=true` 开启发布。

建议配置以下仓库 secrets：

- `RHCLAW_DESKTOP_UPDATER_PRIVATE_KEY`
- `RHCLAW_DESKTOP_UPDATER_PRIVATE_KEY_PASSWORD`
- `RHOPENCLAW_RELEASE_MANIFEST_PRIVATE_KEY`（可选，用于 manifest 签名）
- `RHOPENCLAW_RELEASE_MANIFEST_PUBLIC_KEY`（可选，用于 manifest 签名）
