# RHClaw Channel

运行在 OpenClaw Gateway 中的标准 Channel 插件，用于把 RHOpenClaw 的控制面协议桥接到 OpenClaw 运行时。

## 开发者指南

### 环境要求

- Node.js 22+
- OpenClaw `>= 2026.3.9`

### 本地开发

当前项目级测试不依赖固定的 `.env` 文件。运行期若需要通过环境变量注入设备令牌，建议在 OpenClaw 宿主配置中把 `gatewayTokenRef.id` 约定为统一名称，例如 `RHCLAW_DEVICE_TOKEN`。

```bash
npm install
npm run typecheck
npm run test
```

### 安装方式

正式环境推荐直接通过 npm 安装：

```bash
openclaw plugins install @ruhooai/rhclaw-channel
```

开发或回归场景可使用本地目录安装：

```bash
openclaw plugins install /path/to/RHClaw-Channel
```

### 核心配置

插件统一挂载在 `channels.rhclaw` 下，常用字段包括：

- `serverUrl`
- `deviceSocketUrl`
- `deviceId`
- `gatewayTokenRef`
- `defaultAgentId`
- `heartbeatIntervalSec`

## 技术实现

1. `index.ts` 负责插件注册与 OpenClaw 扩展入口声明。
2. `src/channel.ts` 负责生命周期接入、主流程编排与 Gateway 交互。
3. `src/server-client.ts` 负责控制面 HTTP 与数据面连接管理。
4. `src/inbound.ts` 与 `src/outbound.ts` 负责 RH 协议与 OpenClaw envelope 的双向转换。
5. `src/runtime.ts`、`src/session-map.ts`、`src/status.ts` 负责运行时状态、会话映射与诊断上报。

## 相关文档

