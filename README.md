# dsh-cron · DeepSeek Harness 定时任务插件

对标 **Codex 的 Scheduled Tasks** 的 DeepSeek Harness 实现：在对话里用自然语言创建定时任务，到点由独立 agent 会话执行，结果发回会话；配套一个全屏「已安排」管理页。

包名：`@dsh/cron` ｜ 协议：MIT

---

## 与 Codex Scheduled 的对照

| Codex | dsh-cron |
|---|---|
| 对话中描述任务 → Codex 创建 | 同样：`cron_create` 工具，说人话即可 |
| Scheduled 列表（All/Active/Paused） | 「已安排」全屏页：全部/已开启/已暂停 分组 |
| 任务详情抽屉（prompt、schedule、model 等） | 点任务行展开抽屉，prompt / 运行方式 / 项目 / 模型 / 推理 / 频率 / 运行历史均可编辑 |
| 新建按钮 + 手动创建 | 右上角「新建」+ 页面底部调度建议快捷预填 |
| 运行历史 | 详情抽屉内最近 5 次运行（成功/失败/会话/错误） |

## 快速开始

```text
> 每天早上 9 点跑一次回归测试，用高推理强度，项目用 /path/to/my/repo
```

agent 会 `cron_create` 建好任务；侧边栏「已安排」可管理全部任务。任务参数（prompt / target / schedule / model / reasoningEffort）都可以在详情抽屉里直接改，不必重新说一遍。

## 关键机制

- **调度**：标准 5 段 cron（`分 时 日 月 周`，`*/n`、`a-b`、`?`、月份/星期名称），IANA 时区感知（DST 正确处理），默认 `Asia/Shanghai`；任务存时区，改表达式/恢复时从 `now` 重算下次运行
- **执行**：两种 target——
  - `new-chat`（默认）：每次运行开独立会话 `cron-<jobId>-<occurrence>`，可绑定 project 与 provider/model/reasoningEffort；运行会话会按 project 目录自动挂到对应**工作区分组**下（`workspace.attachSession`），不再落进「未分组」
  - `existing-chat`：投递进指定会话（在线走 maintenance followup，离线从持久化恢复后投递）
- **权限模式**：每个任务可经 `target.permissionMode` 指定运行权限——`read-only`（只读）/ `workspace-write`（工作区写）/ `danger-full-access`（全部访问），创建与编辑（工具、REST、UI 抽屉）均可设置；不指定（或显式传 `null`）则继承部署默认权限——编辑时省略该字段会保留当前值，`null` 才是显式清除。`new-chat` 每次运行的独立会话都会写入该模式；`existing-chat` 则写入目标会话（会持续生效）
- **可靠性**：任务表落盘 `$DSH_HOME/cron/jobs.json`（原子写）；claim 即持久化，崩溃不重跑；漏跑默认跳过（`catchUp: false`）可配置补跑；单次运行失败隔离，记 `failed` 历史并发 `cron/run` 事件
- **管理工具**：`cron_create` / `cron_list` / `cron_update` / `cron_delete` / `cron_pause` / `cron_resume`（仅 root agent 会话）
- **run agent 隔离**：运行会话不注册 cron 管理工具（任务表对 run 不可写）；并通过 factory setup 钩子挂载默认 agent preset，获得与主会话一致的工具集（bash 等）

## UI

「已安排」入口在会话头部与侧边栏底部，打开为全屏页（`shell.overlay` 槽位，无需 fork 侧边栏）：

- 列表：标题 / 状态（运行中/已过期/已暂停）/ 频率 / 时区 / 下次与上次运行，行内暂停/恢复/删除
- 详情抽屉：prompt 编辑、运行于（new/existing chat + 会话 ID）、项目（**工作区选择器**，可手动添加）、模型 + 推理、权限模式（默认/只读/工作区写/全部访问）、频率（cron 输入 + 预设 + 实时预览）、时区、通知（当前仅会话内）、运行历史
- 新建抽屉：与详情同表单，可从调度建议（每天 9 点 / 21 点）预填频率
- 数据走宿主 `webServer` 的 `/cron-api` REST + SSE（30s 轮询兜底）

## 安装

本插件是标准 bundle（声明 `dsh.bundle.patch`），一条命令即装好，自动挂载补丁层，无需手动符号链接或改 profile：

```bash
# 桌面端：设置 → Plugins 页粘贴 github:xiaohaoxing/dsh-cron；或
# CLI 直启：
dsh plugin --profile web add github:xiaohaoxing/dsh-cron
```

装完重启 harness，「已安排」入口即出现在会话头部与侧边栏底部。细节（含纯本地 clone 的替代路径）见 [INSTALL.md](INSTALL.md)。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `timezone` | `Asia/Shanghai` | 默认时区 |
| `catchUp` | `false` | 错过 occurrence 是否补跑 |
| `maxLiveRunAgents` | `20` | 保留的 run agent 上限 |
| `defaultProvider` / `defaultModel` | `deepseek-official` / `deepseek-v4-flash` | run agent 默认模型 |

## 开发

```bash
bash scripts/setup-deps.sh     # 仅离线/手动 fallback 路径需要：链接 @deepseek-ai/dsh-tools 等到仓库 node_modules
node --test "test/*.test.js"   # 65 用例：引擎 / 存储 / 调度 / service / api / tools
```

## License

MIT
