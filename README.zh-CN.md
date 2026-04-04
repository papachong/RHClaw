# RHClaw

[English](README.md) | 中文

RHClaw 是 RHClaw 桌面客户端及相关组件的公开开源工作区。

## 当前模块

当前已公开的模块：

- `RHClaw-Desktop/`：基于 Tauri + React 构建的桌面应用，用于引导本地 OpenClaw 运行时、查看本地状态并管理桌面侧工作流。
- `RHClaw-Channel/`：OpenClaw Gateway 渠道插件，将 RHClaw 控制面协议桥接到 OpenClaw 运行时。

## 快速开始

```bash
cd RHClaw-Desktop
cp .env.example .env.local
npm install
npm run desktop:dev
```

默认配置假设本地 API 服务运行在 `http://localhost:3000/api/v1`。如果你的 API 地址不同，请在启动 Vite 前修改 `.env.local`。

## 注意事项

- 私有源码仓库在开源迁移期间保持只读状态。
- 发布产物、签名密钥和内部部署基础设施已从本仓库中排除。
- 部分打包脚本在本地开发环境之外构建或发布时，仍需设置相应的环境变量。

## Desktop 与 Channel 的联动关系

`RHClaw-Desktop/` 和 `RHClaw-Channel/` 设计为在同一公开工作区中协同使用：

- Desktop 可通过 `RHOPENCLAW_CHANNEL_ROOT` 直接消费 Channel 本地签出源码。
- Desktop 全量离线打包也可通过 `RHOPENCLAW_CHANNEL_PACKAGE_PATH` 消费预构建的 Channel `.tgz` 包。
- 当前 npm 包名保留为 `@rhopenclaw/rhclaw-channel`，以兼容现有的 Desktop 安装器、本地校验逻辑和全量离线打包链路。
- 若后续需要更换 npm scope，必须同步修改 Desktop 前端、Tauri 运行时校验、Rust 侧安装凭据以及打包脚本，需作为一次协调变更统一完成，不能单独修改 Channel 侧元数据。
