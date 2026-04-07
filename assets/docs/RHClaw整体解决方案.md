# OpenClaw 解决方案

## 相关专题文档

1. [RHClaw-Desktop一键安装技术方案](RHClaw-Desktop一键安装技术方案.md)
2. [RHClaw-Channel插件技术方案](RHClaw-Channel插件技术方案.md)

## 一、项目定位

`RHOpenClaw` 的最终产品形态由四个部分组成：

1. `RHOpenClaw-Desktop`
   - OpenClaw 一键安装与配置工具。
   - 负责安装 OpenClaw、安装 RHClaw-Channel、生成绑定二维码、提供设置面板。
   - 安装完成后可退出，不参与运行时消息转发。

2. `RHOpenClaw-IM`
   - 面向用户的小程序端。
   - 负责登录、设备选择、命令输入、结果展示与订阅入口。

3. `RHOpenClaw-Server`
   - 负责鉴权、设备、绑定、命令、订阅、支付、审计与配置下发。

4. `RHOpenClaw-admin`
   - 负责后台配置与运营管理。
   - 维护套餐、模型配置、发布配置和 Desktop 安装策略。

## 二、核心原则

1. OpenClaw 运行时保持官方原样，不做二进制侵入。
2. Desktop 只负责安装、配置与展示，不承担业务通信链路。
3. OpenClaw Gateway 是插件和 Channel 的唯一宿主。
4. RH 业务接入统一通过 `RHClaw-Channel` 插件完成。
5. 服务端是设备、订阅与业务规则的唯一控制面。
6. 面向国内交付时，安装和更新链路优先使用国内镜像与自建更新源。

## 三、系统分层

### 3.1 终端层

1. `RHOpenClaw-IM`
   - 微信登录
   - 设备列表
   - 命令发送
   - 执行结果查看
   - 订阅与支付入口

2. `RHOpenClaw-Desktop`
   - 安装向导
   - OpenClaw 环境检查
   - RHClaw-Channel 安装与配置
   - Gateway 状态查看
   - 绑定二维码展示
   - 模型、订阅、版本等设置面板

3. `RHOpenClaw-admin`
   - 套餐管理
   - 模型与供应商配置
   - 设备与审计管理
   - Desktop 安装策略管理

### 3.2 服务层

1. `Auth Service`
   - 微信登录桥接
   - 用户会话签发
   - 设备令牌签发与撤销

2. `Device Service`
   - 设备注册、绑定、解绑、冻结、替换
   - 设备在线状态维护

3. `Command Service`
   - 命令创建、投递、ACK、执行状态流转、结果回写

4. `Subscription Service`
   - 套餐、支付、权益与设备额度控制

5. `Admin Service`
   - 后台鉴权、配置管理、运营入口

6. `Audit Service`
   - 后台操作、设备动作、关键业务事件审计

### 3.3 运行时层

1. `OpenClaw Gateway`
   - 运行官方 Gateway
   - 加载官方 plugins 与 `RHClaw-Channel`
   - 托管 `bindings` 与运行时路由

2. `RHClaw-Channel`
   - 负责与 `RHOpenClaw-Server` 建立控制面和数据面连接
   - 负责命令接收、ACK、执行调度与结果回传

## 四、Desktop 最终职责

Desktop 的职责固定为：

1. 调用官方 CLI 执行 OpenClaw 安装、修复、复用与重装。
2. 安装并启用 `RHClaw-Channel`。
3. 写入默认模型、Gateway 参数和插件配置。
4. 创建绑定会话并展示二维码。
5. 提供订阅、模型、版本和运行状态面板。

Desktop 明确不负责：

1. 命令接收与转发。
2. 执行结果上报。
3. 设备长连接保活。
4. 运行时消息桥接。

Desktop 退出后，Gateway 继续由系统守护进程托管，通信链路不受影响。

## 五、安装与配置方案

### 5.1 OpenClaw 安装主路径

统一使用官方 CLI：

```bash
openclaw onboard \
  --non-interactive \
  --json \
  --mode local \
  --gateway-bind loopback \
  --gateway-port 18789 \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --install-daemon \
  --daemon-runtime node \
  --accept-risk
```

### 5.2 环境检查模型

Desktop 安装前统一采用五态检查：

1. `missing_cli`
2. `broken_install`
3. `installed_not_running`
4. `installed_needs_repair`
5. `installed_reusable`

对应动作固定为：

1. 缺失或损坏：直接重装。
2. 已安装未运行：先尝试启动 Gateway，再落为复用或修复。
3. 可修复：允许修复或重装。
4. 可复用：允许复用或重装。

### 5.2.1 安装路径识别与回写约束

Desktop 对 OpenClaw 安装路径的识别与回写遵循以下规则：

1. 只有 `existing-install` 复用模式允许保留 `boundInstallPath`，用于绑定用户明确指定的现有 OpenClaw 路径。
2. `official-cli-onboard`、`repair`、离线升级等非复用模式，不再把历史 `boundInstallPath` 作为兜底路径写回 manifest，也不再向工作台回显该旧路径。
3. macOS 下 OpenClaw CLI 的识别优先级为：
   - Desktop 自管安装目录
   - 当前用户 shell 可见的 `openclaw`
   - `.local/bin` 与 nvm/fnm/asdf/volta/pnpm 等 node manager 安装路径
   - `~/Applications/OpenClaw.app`
   - `/Applications/OpenClaw.app`
4. 离线包版本高于当前版本并完成升级安装后，若不是复用已有安装，工作台应显示升级后的实际 CLI 路径，而不是旧 App 路径。
5. 若 Desktop 自管路径尚未真正落盘，则工作台可以回退到用户环境中可执行的 OpenClaw CLI；但该回退不应依赖陈旧 manifest 中的 `boundInstallPath`。

### 5.3 Skills 安装策略

Desktop 安装阶段的 skills 行为由服务端下发，Admin 维护。

只保留推荐预装模式：

1. Desktop 首次安装时预装一组推荐 skills 并校验可用。
2. 已安装的 skills 不重复破坏；缺失项通过 SkillHub 在线补齐。
3. SkillHub CLI 为唯一在线 skills 安装工具，站点为 `https://skillhub.tencent.com/`。
4. Windows 上若 SkillHub CLI 不可用（无 bash / 无 Python），Desktop 自动降级为 Rust 原生 HTTP 下载 skill zip 并解压，零外部依赖。
5. 首次安装完成后，用户自行维护 skills，服务端不做长期目标状态管理。

## 六、RHClaw-Channel 方案

### 6.1 交付形态

最终只保留插件方案：

1. 插件显示名：`RHClaw Channel`
2. `channelId`：`rhclaw`
3. npm 包名：`@ruhooai/rhclaw-channel`

### 6.2 职责

`RHClaw-Channel` 负责：

1. 与 `RHOpenClaw-Server` 建立 WebSocket 或等价长连接。
2. 接收命令并完成 ACK。
3. 调度 OpenClaw 执行并收集结果。
4. 向 Server 回传执行结果和状态变更。

### 6.3 路由原则

1. 所有 Channel 都挂在 OpenClaw Gateway 下。
2. `bindings` 继续由 OpenClaw 官方路由层管理。
3. RH 业务不旁路 Gateway，不直接侵入 OpenClaw 内部实现。

## 七、绑定与订阅规则

### 7.1 绑定链路

绑定链路固定为：

1. Desktop 注册设备。
2. Desktop 创建绑定会话。
3. Desktop 展示二维码。
4. 用户在小程序中登录并确认绑定。
5. Server 完成设备归属。

### 7.2 绑定与订阅解耦

最终规则如下：

1. 用户可以在无有效订阅时完成设备绑定。
2. 绑定成功后，如订阅不可用，则设备保留归属，但执行权限冻结。
3. 订阅恢复后，设备无需重新绑定即可恢复可用。
4. 未完成正式绑定且会话已过期的预注册设备，由服务端回收。

## 八、命令与消息流

### 8.1 命令流

命令链路固定为：

1. 小程序向 Server 发起命令。
2. Server 落库并创建目标执行记录。
3. Server 将命令下发给 `RHClaw-Channel`。
4. `RHClaw-Channel` 在 Gateway 内完成执行调度。
5. 执行结果回传 Server。
6. Server 将结果推送给小程序。

### 8.2 消息原则

1. 数据库落库是事实源。
2. Realtime 只负责通知与状态同步。
3. 命令与消息分层：命令负责执行，消息负责展示。
4. 小程序端优先消费结构化消息与结果摘要。

## 九、服务端技术基线

当前基线统一为：

```text
+ NestJS
+ PostgreSQL
+ Prisma
+ Redis
+ Redis Pub/Sub
+ MinIO
+ JWT 鉴权
+ WebSocket Gateway
+ 微信登录桥接
+ 订阅权益服务
+```

部署策略：

1. 一期采用单体 NestJS 进程承载 `API + WebSocket Gateway`。
2. 代码按 `Auth / Device / Command / Subscription / Audit / Admin` 模块边界组织。
3. 后续如需扩展，再拆分服务或替换消息总线。

## 十、国内交付方案

面向国内用户的最终交付基线如下：

1. Desktop 自身升级使用 Tauri updater + 国内自建更新源。
2. OpenClaw 安装优先使用国内镜像与离线资产。
3. 离线包与镜像目录统一由 Desktop 构建脚本生成。
4. macOS x64 离线打包默认走 `FULL-OFFLINE-ONLY` 模式，先准备 `release/openclaw-bootstrap/full-offline-only/macos-x64/` 下的全量离线输入物料，再生成最终 Desktop 安装包。
5. 面向用户交付的安装包、离线包、manifest 与运行时默认值中，不允许出现海外源地址；外网访问只允许发生在本地打包或 CI 制作阶段。
6. 面向用户分发的安装脚本和 manifest 不包含海外源地址。

## 十一、最终结论

`RHOpenClaw` 的最终方案收敛为：

1. Desktop 是 OpenClaw 的安装与配置工具，不是通信中继。
2. OpenClaw Gateway 是运行时核心，`RHClaw-Channel` 是 RH 业务接入层。
3. Server 是设备、绑定、订阅与命令的唯一业务控制面。
4. 小程序是用户主入口，Desktop 是安装与设置入口。
5. 全链路以“官方 CLI + Gateway 插件 + 服务端控制面 + 国内交付资产”为统一落地方案。
