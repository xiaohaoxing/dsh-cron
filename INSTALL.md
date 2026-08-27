# dsh-cron 安装手册

本文档面向要**安装这个插件**的人。如果你是普通用户（已经装好了），直接看 [README](README.md) 的"快速上手"就行。

> 包名：`@dsh/cron`（旧名 `@walltech/dsh-cron`，2026-08 起不再使用）

---

## 0. 安装前要知道的事

- 本插件是一个 **DeepSeek Harness 插件**，装在你的 DSH 环境（桌面应用或 CLI 启动的 profile）里；
- 插件本体是一个 npm 包，但**不需要发布到 npm registry**——本地目录 + 符号链接即可；
- 源码仓库：https://github.com/xiaohaoxing/dsh-cron

### 两种安装方式怎么选

| 场景 | 用哪种 |
|---|---|
| 用 **DSH 桌面应用**（双击打开的那种） | **方式一**（推荐） |
| 自己用命令行 `dsh --profile web` 启动 | **方式二** |

> ⚠️ **桌面应用用户注意**：不要用 `pnpm add` 把它装进 web profile。桌面应用每次启动会重写 profile 的 `package.json` / `node_modules`，手工加进去的依赖会被清掉（日志表现为 `Cannot find package ...`）。桌面端正确的装法是**方式一**的"扁平 fallback 目录"。

---

## 方式一：DSH 桌面应用（推荐）

### 第 1 步：准备好插件目录

把仓库放到一个固定位置，例如：

```bash
git clone https://github.com/xiaohaoxing/dsh-cron.git /Users/you/repos/dsh-cron
```

> 之后想更新插件，直接 `git -C /Users/you/repos/dsh-cron pull` 再重启应用即可。

### 第 2 步：符号链接到 fallback 目录

DSH 桌面应用会从一个"扁平 fallback 目录"加载额外插件：
`$DSH_HOME/profiles/node_modules/`（`$DSH_HOME` 一般是 `~/.dsh`）。

```bash
mkdir -p "$HOME/.dsh/profiles/node_modules/@dsh"
ln -sfn /Users/you/repos/dsh-cron "$HOME/.dsh/profiles/node_modules/@dsh/cron"
```

验证链接（应该能看到指向你的仓库）：

```bash
ls -la "$HOME/.dsh/profiles/node_modules/@dsh/"
# 输出示例：
# cron -> /Users/you/repos/dsh-cron
```

### 第 3 步：挂载配置

编辑 profile 配置 `$HOME/.dsh/profiles/web/cordis.patch.yml`，**追加**以下内容：

```yaml
- insert:
    - id: cron
      name: '@dsh/cron'
      config:
        timezone: Asia/Shanghai
        catchUp: false
        maxLiveRunAgents: 20
        defaultProvider: deepseek-official
        defaultModel: deepseek-v4-flash
```

各配置项含义见 [README · 配置项](README.md#配置项)。

> 如果文件里已经有 `@dsh/cron` 的这段，把旧的 `@walltech/dsh-cron` 那一行改成 `@dsh/cron` 即可（id `cron` 保持不变）。

### 第 4 步：重启应用

完全退出并重新打开 DSH 桌面应用（或重启 harness）。

### 第 5 步：验证

重启后确认三件事：

1. **任务表接口正常**：浏览器打开 `http://127.0.0.1:<端口>/cron-api/jobs`，应返回 `{"ok":true,"jobs":[...]}`（端口是你 GUI 的端口）；
2. **入口出现**：侧边栏底部和会话头部出现「已安排」按钮；
3. **创建任务**：在对话里说一句"每天早上 9 点跑一次回归测试"，AI 会调用 `cron_create` 建好任务；到「已安排」页面能看到它。

---

## 方式二：CLI 直启（`dsh --profile web`）

CLI 场景没有桌面维护进程，可以直接让 dsh 安装插件：

```bash
dsh plugin --profile web add /Users/you/repos/dsh-cron
```

然后同样在 `cordis.patch.yml` 追加第 3 步那一段（id `cron`，name `@dsh/cron`），重启 `dsh` 进程。

---

## 常见问题（FAQ）

**Q：日志报 `Cannot find package '@dsh/cron' imported from .../profiles/web/`**
A：插件没被找到。检查：① 符号链接是否在 `$HOME/.dsh/profiles/node_modules/@dsh/cron`；② 链接目标目录里是否有 `package.json`；③ 重启过没有。

**Q：装好了但对话里没有 `cron_*` 工具**
A：工具注册在**新开的 root agent 会话**上。请开一个新对话再试；老对话不生效。

**Q：到点了任务没跑**
A：先看「已安排」里任务的**状态**：
- 显示"已暂停"→ 点行内 ▶ 恢复；
- 显示"已过期"→ 说明错过的时间点被跳过（`catchUp: false` 默认不补跑），恢复后从下一次时间重新排期；
- 状态正常但没跑 → 看运行历史里的失败原因（点开任务详情）。

**Q：任务建好了，但运行总是失败**
A：打开任务详情看**运行历史**里的错误信息。常见原因：运行会话缺少所需工具、路径写错、目标会话不存在。

**Q：怎么卸载？**
A：① 从 `cordis.patch.yml` 删掉 `@dsh/cron` 那段；② 删掉符号链接 `rm "$HOME/.dsh/profiles/node_modules/@dsh/cron"`；③ 重启应用。任务表文件（`$HOME/.dsh/cron/jobs.json`）可以留着（重新安装后任务还在），想彻底清掉就一并删除。

---

## 数据存放位置

| 内容 | 位置 |
|---|---|
| 任务表 | `$HOME/.dsh/cron/jobs.json` |
| 每次运行的会话记录 | `$HOME/.dsh/sessions/...`（与普通会话同目录） |
| 浏览器 UI 静态资源 | 由插件在 harness 内 serve：`/plugins/@dsh/cron/client.js` |
