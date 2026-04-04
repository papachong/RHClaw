# RHClaw-Channel 开源执行计划

## 一、目标

将私有仓中的 `RHClaw-Channel/` 以独立子项目形式迁移到公开仓 `RHClaw/RHClaw-Channel/`，形成可阅读、可安装、可测试、可继续演进的公开插件仓形态。

本阶段目标是先完成“开源准备与公开化改造计划”，不在私有仓直接修改源码；私有仓仍保持只读，所有实际导入与改造均发生在公开仓。

## 二、源与目标

### 2.1 源路径

- 私有源目录：`/Users/gallenma/AI_Dev/RHOpenclaw/RHClaw-Channel`
- 参考文档：
  - `docs/RHClaw Channel插件技术方案.md`
  - `docs/RHClaw Channel插件开发计划.md`
  - `docs/RHOpenClaw-Desktop与Channel打包发布到OSS方案.md`

### 2.2 目标路径

- 公开仓根目录：`/Users/gallenma/AI_Dev/RHClaw`
- 公开子目录：`/Users/gallenma/AI_Dev/RHClaw/RHClaw-Channel`
- 计划文档落点：`/Users/gallenma/AI_Dev/RHClaw/docs/RHClaw-Channel开源执行计划.md`

## 三、当前盘点结论

### 3.1 项目形态

`RHClaw-Channel` 当前已经是独立 Node.js / TypeScript 插件项目，主要文件包括：

- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- `src/`
- `test/`
- `README.md`

这意味着它比 Desktop 更接近“可直接开源”的状态，不需要从私有 monorepo 中拆过多业务壳逻辑。

### 3.2 已识别的开源风险项

1. 当前目录中包含明显不应导入公开仓的构建与缓存产物：
   - `node_modules/`
   - `rhclaw-channel-0.1.0.tgz`
   - `rhopenclaw-rhclaw-channel-1.0.3.tgz`
   - `pack-report.txt`
   - `size-report.txt`
   - `.DS_Store`

2. 包元数据尚未切换到公开仓口径：
   - `package.json` 的 `license` 仍为 `UNLICENSED`
   - 包名仍为 `@rhopenclaw/rhclaw-channel`
   - 描述、关键词、blurb 仍偏向 `RHOpenClaw` 内部命名

3. README 与配置 Schema 仍带有未公开化品牌文案：
   - `RHOpenClaw custom channel plugin`
   - `RHOpenClaw API 地址`
   - `api.rhopenclaw.example.com`

4. 测试样例仍包含线上私有域名：
   - `https://request.ruhooai.com/api/v1`
   - `https://request.ruhooai.com/device`

5. Channel 与 Desktop 之间存在后续联动要求：
   - Desktop 当前 full-offline 打包链路会消费 `RHClaw-Channel` 的源码或 tgz
   - 公开仓中需要明确两者的协作关系，但不能保留私有发布基础设施假设

### 3.3 当前执行结论（2026-04）

1. `RHClaw-Channel/` 已完成首轮白名单导入与公开化清理。
2. `npm install`、`npm run typecheck`、`npm run test` 已在公开仓子项目内通过。
3. 当前阶段不调整 npm 包 scope，继续保留 `@rhopenclaw/rhclaw-channel`：
   - Desktop 前端默认状态、安装入口和 fallback 文案仍直接引用该 package spec。
   - Desktop Rust 侧把该包名作为本地安装校验、install receipt 校验和自愈安装链路的一部分。
   - full-offline 打包脚本与离线材料清单也仍按现有包名和产物结构工作。
4. 后续若要切换到新的公开 scope，需要把 Channel、Desktop 前端、Tauri Rust 校验和离线打包脚本作为一次联动改造统一处理。

## 四、公开仓目标形态

计划完成后，公开仓结构应至少演进为：

```text
RHClaw/
├── LICENSE
├── README.md
├── docs/
│   └── RHClaw-Channel开源执行计划.md
├── RHClaw-Desktop/
└── RHClaw-Channel/
    ├── README.md
    ├── package.json
    ├── package-lock.json
    ├── openclaw.plugin.json
    ├── index.ts
    ├── src/
    ├── test/
    ├── tsconfig.json
    └── .gitignore
```

## 五、导入范围与排除项

### 5.1 首批导入白名单

首批允许进入公开仓的文件：

- `README.md`
- `index.ts`
- `openclaw.plugin.json`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/**`
- `test/**`

### 5.2 必须排除的文件

以下内容不得进入公开仓：

- `node_modules/**`
- `*.tgz`
- `pack-report.txt`
- `size-report.txt`
- `.DS_Store`
- 任何本地缓存、构建产物、私有凭据文件

## 六、执行阶段划分

### P0：计划冻结

目标：冻结 Channel 首批公开范围与公开口径。

任务：

1. 确认公开子目录固定命名为 `RHClaw-Channel/`。
2. 确认私有仓只读，后续仅向公开仓导入。
3. 确认首批只开放插件源码、测试、README 与基础配置，不包含打包缓存与离线产物。

### P1：源码导入

目标：把私有仓中的 Channel 项目以白名单方式复制到公开仓。

任务：

1. 在公开仓创建 `RHClaw-Channel/`。
2. 只导入白名单文件和目录。
3. 为公开仓补充 `RHClaw-Channel/.gitignore`，拦截 `node_modules`、tgz、临时报告和本地缓存。

验收：

1. 公开仓出现独立 `RHClaw-Channel/` 目录。
2. 目录内不含任何构建缓存与私有报告文件。

### P2：元数据与文案公开化

目标：把项目从“私有插件包口径”调整为“公开仓插件项目口径”。

任务：

1. 调整 `README.md`，删除或改写仅适用于私有环境的叙述。
2. 评估并修改 `package.json`：
   - `license` 与公开仓 LICENSE 对齐
   - 当前阶段保留 `@rhopenclaw/rhclaw-channel`，scope 改名留到后续联动改造单独处理
   - 更新 `description`、`keywords`、`openclaw.channel.blurb`
3. 审核 `openclaw.plugin.json` 与配置文案，去掉不必要的私有品牌措辞。

验收：

1. 仓库文案可直接面对公开用户阅读。
2. 许可证字段不再与公开仓根许可证冲突。
3. 包名策略形成明确结论，并记录当前兼容性保留原因。

### P3：默认值与测试样例公开化

目标：把样例地址、测试桩和配置占位值改成公开友好形式。

任务：

1. 将测试中的 `request.ruhooai.com` 改为本地域名或 `example.com` 占位值。
2. 审核 `src/config-schema.ts` 等文件中的 placeholder：
   - `https://api.rhopenclaw.example.com/api/v1`
   - `wss://api.rhopenclaw.example.com/device`
3. 统一决定这些示例值采用：
   - 纯通用占位
   - 公开品牌域名占位
   - 本地默认值 + README 指引

验收：

1. 仓内不再出现私有生产域名。
2. 示例地址对公开用户可理解、可替换。

### P4：与 Desktop 的公开协作口径对齐

目标：让 Desktop 与 Channel 在公开仓中保持一致的依赖说明。

任务：

1. 在根 README 或子项目 README 中说明：
   - `RHClaw-Desktop` 可消费 `RHClaw-Channel` 源码或 tgz
   - full-offline 构建需要显式提供 Channel 输入
2. 避免在 Channel 项目中引入私有发布、OSS、签名和密钥假设。
3. 形成“本地开发 / 本地联调 / 公开构建”的明确边界。

验收：

1. Desktop 与 Channel 的关系可被公开仓读者理解。
2. 不新增任何私有基础设施依赖。

### P5：验证与验收

目标：确保 Channel 子项目在公开仓中可读、可安装、可测试。

任务：

1. 执行 `npm install`。
2. 执行 `npm run typecheck`。
3. 执行 `npm run test`。
4. 复扫敏感词、私有域名、私有路径与未公开许可证标记。

验收：

1. 基础安装与校验命令可通过。
2. 无 `UNLICENSED`、无私有线上域名、无构建缓存误入。

## 七、重点决策项

以下问题需要在正式导入前后尽快确认：

1. npm 包名是否继续保留 `@rhopenclaw/rhclaw-channel`。
   - 当前结论：首轮公开化继续保留，用于兼容 Desktop 现有安装与校验链路。
2. 若后续进入第二轮联动改造，是否改为：
   - `@rhclaw/rhclaw-channel`
   - `rhclaw-channel`
   - 其他公开 scope
3. 配置 Schema 中的 API placeholder 是否采用公开品牌域名，还是纯通用示例域名。
4. 根仓 README 是否把 `RHClaw-Channel` 提升为与 Desktop 并列的公开模块。

### 7.1 第二轮 scope 重命名联动清单

若后续决定把 npm 包名从 `@rhopenclaw/rhclaw-channel` 迁移到新的公开 scope，需要按“跨仓联动改造”处理，而不是只改 `RHClaw-Channel/package.json`。

当前已确认的影响面如下：

1. Desktop 前端默认值与状态展示：
   - `RHClaw-Desktop/src/constants/defaults.ts`
   - `RHClaw-Desktop/src/services/tauri-agent.ts`
   - `RHClaw-Desktop/src/hooks/useDesktopRuntime.ts`
   - 这些位置当前直接把 `@rhopenclaw/rhclaw-channel` 作为 package spec 写死。

2. Desktop Rust 侧安装、自愈与校验链路：
   - `RHClaw-Desktop/src-tauri/src/main.rs`
   - 当前会校验 `package.json.name == "@rhopenclaw/rhclaw-channel"`
   - 当前 install receipt 也会校验 `receipt.package_name == "@rhopenclaw/rhclaw-channel"`
   - 若只改 Channel 包名而不改这里，Desktop 会把插件判定为无效安装。

3. full-offline 打包与平台封装脚本：
   - `RHClaw-Desktop/scripts/build-full-offline-materials.mjs`
   - `RHClaw-Desktop/scripts/package-mac.sh`
   - `RHClaw-Desktop/scripts/package-win.ps1`
   - 当前离线包目录名仍是 `packages/rhclaw-channel/`，打包脚本和 manifest 读取逻辑都依赖这一约定。

4. 文档与安装入口：
   - 根 `README.md`
   - `RHClaw-Desktop/README.md`
   - `RHClaw-Channel/README.md`
   - 这些位置需要与最终 package spec 保持一致，避免用户按照旧命令安装。

5. 需要特别区分“npm 包名”和“插件 id”：
   - `openclaw.plugin.json` 当前 `id` 为 `rhclaw-channel`
   - Desktop Rust 侧大量路径和 allow 列表逻辑也依赖 `rhclaw-channel`
   - 第二轮改造可以只改 npm scope，而不改插件 id 与本地扩展目录名；否则影响面会进一步扩大。

建议第二轮改造按以下顺序执行：

1. 先决定是否只改 npm scope、不改插件 id。
2. 同步修改 Channel `package.json`、Desktop 前端默认 package spec、Rust 安装校验与 install receipt 校验。
3. 再修改 full-offline 构建、平台封装脚本和相关 README。
4. 最后执行一次 Desktop + Channel 联合验证，确认本地安装、自愈安装和离线打包同时通过。

## 八、建议执行顺序

建议严格按以下顺序推进：

1. 先导入白名单源码。
2. 再做包元数据、README 和测试地址公开化。
3. 然后补 Desktop 与 Channel 的公开协作说明。
4. 最后做安装、类型检查、测试与敏感信息复扫。

这样可以避免一开始就把复杂度压到 Desktop 联动和 npm 发布命名决策上，同时能先把 `RHClaw-Channel` 作为独立开源项目稳定落到公开仓。

## 九、首批验收清单

首批执行完成后，应满足以下条件：

1. `RHClaw/RHClaw-Channel/` 已在公开仓落地。
2. 不包含 `node_modules`、tgz、pack 报告和本地垃圾文件。
3. README、包元数据、配置占位值已切换为公开口径。
4. 测试样例中不再引用私有线上域名。
5. `npm install`、`npm run typecheck`、`npm run test` 可在公开仓独立执行。
6. 已在仓库文档中明确记录当前保留旧 npm scope 的兼容性原因。
