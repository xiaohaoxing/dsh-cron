# @walltech/dsh-cron

DeepSeek Harness 的 cron 执行器插件：**全局持久化任务表 + 时区感知调度器 + 自然语言友好的管理工具**。

- 5 字段 cron 表达式（`minute hour day-of-month month day-of-week`），支持 `*`、`*/n`、`a-b`、`a,b`、`?`（dom/dow）、`JAN..DEC` / `SUN..SAT` 名称
- IANA 时区感知（DST 跳时/重叠正确处理，算法与 `@deepseek-ai/dsh-schedule` 一致）
- 任务表落盘 `$DSH_HOME/cron/jobs.json`，原子写（tmp + fsync + rename），崩溃不丢、不重跑已 claim 的 occurrence
- 两种执行策略：
  - `new-chat`（默认）：每次运行创建独立 agent 会话 `cron-<jobId>-<occurrence>`，可绑定工作目录（project）与模型/推理强度
  - `existing-chat`：投递进目标会话（活体 agent 用 `runMaintenance`+`followup`，不在线则从持久化恢复后投递）
- 漏跑策略：`catchUp: false`（默认）跳过错过的 occurrence 并记 `skipped` 历史；`catchUp: true` 补跑最早的错过 occurrence
- 管理工具：`cron_create` / `cron_list` / `cron_update` / `cron_delete` / `cron_pause` / `cron_resume`
- 事件：`cron/change`（任务表变更）、`cron/run`（`{ jobId, occurrence, status: started|ok|failed, sessionId?, error? }`）
- **P1 浏览器 UI**：会话头部与侧边栏底部的「已安排」入口，点击打开**独立全屏页面**展示全部任务（下次/上次运行、暂停/恢复/删除），数据走宿主 `webServer` 上的 `/cron-api` REST + SSE 桥
- 注入：`['agents', 'sessions', 'tools', 'sessionPersistence', 'webServer']`——`webServer` 在 inject 里保证 fiber 在 webserver 宿主激活后才运行（缺失时插件整体不激活，优雅降级）

## 目录

```
lib/
  cron.js     纯函数 cron 引擎（零依赖：解析、next occurrence、describe、时区）
  store.js    CronStore：磁盘任务表 + 校验 + 原子持久化
  runtime.js  CronRuntime：定时唤醒、claim-then-execute、两种执行策略、并发尾串行化
  service.js  共享变更核心：工具与 REST API 共用的校验/持久化代码路径
  tools.js    六个管理工具注册（defineTool + closed-union 错误码）
  api.js      /cron-api REST + SSE 桥（注册到宿主 webServer）
  client.js   浏览器 half（module-loader bundle 格式，P1「已安排」UI）
  index.js    Cordis function plugin 挂载（name/inject/apply）
test/         node:test 单测（48 个用例）
cordis.patch.yml  挂载样例
```

## 浏览器 UI（P1）

`dsh.client` 双面声明让 `lib/client.js` 进入 `window.__DSH_BOOT__` 图，由
`@deepseek-ai/dsh-client-modules` 在 `/plugins/@walltech/dsh-cron/client.js` 提供服务。
客户端 bundle 以框架同款的 `window.__ModuleLoader__.load` 格式手写，**无需构建步骤**。

注册位置（三个官方框架槽位，共用同一任务列表渲染 `JobListContent`，**无需 fork 侧边栏**）：

| slot | 行为 |
|---|---|
| `conversation.session.header.actions` | 会话头部「已安排」按钮（order 30） |
| `sidebar.footer.action` | 侧边栏底部按钮，与 Settings 并列（wide 显示图标+文字 / rail 仅图标，order 20）。wide 模式下整个底部动作列表**纵向堆叠**（每个插件的入口各占一行，如 Remote / 已安排），由插件注入的 CSS 覆盖框架页脚容器 `.hHd-Xa_footerActions`（框架升级需复查该类名） |
| `shell.overlay` | 「已安排」**独立页面**：点任一入口打开全屏页面列出全部任务（暂停/恢复/删除、刷新、Esc/遮罩关闭，order 10） |

> **官方槽位依据**：槽位清单见
> [slot-catalog.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts)。
> 浏览区只有 `sidebar.workspaces`（`single`，ui-workspace 独占，第三方注册会冲突）；
> 第三方可用的框架级全屏面是 `shell.overlay`（`list`，additive）——独立页面即挂在这里。
> 早期版本曾 fork 侧边栏增加 `sidebar.sections` 内嵌分组（`@walltech/dsh-client-ui-sidebar`），
> 已弃用并移除，发布为单包不再依赖任何框架 fork。

数据桥（宿主 half 注册到 `ctx.webServer`，与 `/plugins/*` 同为本地 127.0.0.1 开放路由）：

```
GET    /cron-api/jobs          → { ok, jobs: [view+label], timezone }
POST   /cron-api/jobs          → 创建（body = cron_create 参数）→ view
PATCH  /cron-api/jobs/<id>     → 更新/暂停/恢复（body = 字段补丁）→ view
DELETE /cron-api/jobs/<id>     → { ok, id, deleted }
GET    /cron-api/events        → SSE：change / run 事件（客户端收到后重新拉取）
```

- 变更与工具同一条 `service.js` 代码路径（一处校验/持久化，工具与 UI 行为一致）
- 每次变更发 `cron/change`：既驱动调度器重新武装，也推送 SSE 通知
- 客户端策略：初次拉取 + SSE 实时更新 + 30s 轮询 + 窗口聚焦时刷新（SSE 断开自动兜底）

## 安装与挂载

### 桌面应用（DSH Desktop）

⚠️ **不要直接 `pnpm add` 进 web profile**：桌面应用启动时会把 profile 的
`package.json`/`node_modules` 重写为其管理的集合（dsh-remote 等捆绑插件），
任何手工加进去的依赖会在下次启动被清除（日志表现为
`Cannot find package '@walltech/dsh-cron' imported from .../profiles/web/`）。

桌面端正确的持久化安装位置是**扁平 fallback 目录**
`$DSH_HOME/profiles/node_modules/`（app-boot 的 `healProfilesModuleFallback`
维护它，只增不减；桌面自己的 `@dsh-desktop/integration` 也装在这里）：

```bash
# 1. 符号链接到 fallback 目录（Node 从 profile 的父目录 walk 会命中它）
mkdir -p "$DSH_HOME/profiles/node_modules/@walltech"
ln -sfn /path/to/dsh-cron "$DSH_HOME/profiles/node_modules/@walltech/dsh-cron"

# 2. 挂载（追加到 $DSH_HOME/profiles/web/cordis.patch.yml）
```

```yaml
- insert:
    - id: cron
      name: '@walltech/dsh-cron'
      config:
        timezone: Asia/Shanghai   # 默认时区
        catchUp: false            # 是否补跑错过的 occurrence
        maxLiveRunAgents: 20      # 保留的 run agent 上限（释放后会话 JSONL 仍在）
        defaultProvider: deepseek-official
        defaultModel: deepseek-v4-flash
```

### 非桌面（CLI 直启）

CLI 场景（`dsh --profile web` 由你自己启动，没有桌面维护进程）可直接 pnpm 安装：
`dsh plugin --profile web add /path/to/dsh-cron`，再挂载同一段 patch。

重启（或 HMR 热更新）后，任意 root agent 即获得 `cron_*` 工具。自然语言创建示例：

> “每天早上 9 点跑一次回归测试，用高推理强度，项目用 /path/to/my/repo”

agent 会调用 `cron_create`，参数如下：

```
cron_create({
  prompt: '跑一次回归测试并给出结论',
  schedule: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  target: { kind: 'new-chat', project: '/path/to/my/repo', reasoningEffort: 'high' },
  title: '每日回归测试'
})
```

## 行为语义

- **claim 即持久化**：到点先把 `lastRunAt`/`nextRunAt` 落盘再执行，进程崩溃不会重复执行同一 occurrence
- **不重复运行**：claim 后 `nextRunAt` 严格取 `now` 之后的 occurrence，同一分钟内不会二次触发
- **漏跑**：occurrence 晚于 60s 宽限且 `catchUp: false` → 跳过并记 `skipped`；`catchUp: true` → 补跑最早的错过 occurrence 一次
- **不可达日期**（如 `0 0 30 2 *`）→ 无未来 occurrence，任务自动禁用并告警
- **执行失败隔离**：每次运行 try/catch 包裹，记 `failed` 历史 + 发 `cron/run` 事件，不影响其他任务
- **时区变更/恢复**：任务存 IANA 时区；`cron_update` 改表达式/时区、`cron_resume` 恢复过期任务时都从 `now` 重算 `nextRunAt`

## 错误码（closed union）

`invalid_expression` / `invalid_time_zone` / `invalid_target` / `invalid_prompt` / `invalid_id` / `not_found` / `persistence_uncertain` / `internal_error`

## 开发

```bash
node --test "test/*.test.js"   # 48 个用例（引擎 / store / runtime / service / api / tools）
```

`node_modules/` 下是指向 DSH 安装的符号链接（仅本地跑测试用；`files` 只发布 `lib`）。

## 后续（P2+）

- 详情编辑表单（schema 驱动，P2）
- 运行历史 UI（订阅 `cron/run` 事件）
- 通知通道（Web 通知 / IM 机器人）
- cron-parser 替换自研引擎（如需 6 段秒级表达式）

## License

MIT
