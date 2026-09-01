# dsh-cron 安装手册

本文档面向要**安装这个插件**的人。如果你是普通用户（已经装好了），直接看 [README](README.md) 的"快速上手"就行。

> 包名：`@dsh/cron`（旧名 `@walltech/dsh-cron`，2026-08 起不再使用）

---

## 0. 安装前要知道的事

- 本插件是一个 **DeepSeek Harness bundle**（`package.json` 声明了 `dsh.bundle.patch`），装在你的 DSH 环境（桌面应用或 CLI 启动的 profile）里；
- 插件本体是一个 npm 包，但**不需要发布到 npm registry**——通过 GitHub 源或本地目录安装即可；
- 源码仓库：https://github.com/xiaohaoxing/dsh-cron

### 一句话安装

因为插件是标准 bundle，**一条命令就能装好**，自动挂载补丁层，不需要手动符号链接，也不需要手改 `cordis.patch.yml`：

```bash
# 桌面端：打开 设置 → Plugins，粘贴下面的地址并安装（二选一即可）
# CLI 直启：
dsh plugin --profile web add github:xiaohaoxing/dsh-cron
```

装完**重启 harness**，「已安排」入口就会出现在会话头部与侧边栏底部。

> 💡 为什么不用以前的 `setup-deps.sh` + 符号链接？
> 新版把插件做成了 bundle，它需要的框架依赖（`@deepseek-ai/dsh-tools` 等）会由 harness 运行期的共享 fallback 目录解析，**不需要**在仓库里预链接。手动那套（clone + setup-deps + 符号链接 + 改 patch）只在"离线、没有 dsh plugin / 不想走 GitHub 源"时才需要，见下文「替代路径」。

---

## 标准安装（推荐）

### 用 DSH 桌面应用

1. 打开 **设置（Settings）→ Plugins** 页面；
2. 粘贴 `github:xiaohaoxing/dsh-cron`，点安装；
3. 完全退出并重新打开应用（或重启 harness）。

若你的桌面插件页没有手动输入源，改用 CLI 一句话：

```bash
dsh plugin --profile web add github:xiaohaoxing/dsh-cron
```

### 用 CLI 直启（`dsh --profile web`）

```bash
dsh plugin --profile web add github:xiaohaoxing/dsh-cron
```

### 安装后验证

1. **任务表接口正常**：浏览器打开 `http://127.0.0.1:<端口>/cron-api/jobs`，应返回 `{"ok":true,"jobs":[...]}`（端口是你 GUI 的端口）；
2. **入口出现**：侧边栏底部和会话头部出现「已安排」按钮；
3. **创建任务**：在对话里说一句"每天早上 9 点跑一次回归测试"，AI 会调用 `cron_create` 建好任务；到「已安排」页面能看到它。

---

## 替代路径：纯本地 clone（离线）

适用场景：没有托管到 GitHub 源、或你想直接用本地仓库目录安装。与上面等价，只是源换成路径。

```bash
# 用本地目录作为 bundle 源安装（dsh 会按目录里的 package.json 解析）
dsh plugin --profile web add /Users/you/repos/dsh-cron
```

若上面这种方式在你的环境里解析不到框架依赖（个别打包/隔离的 DSH 安装），回退到手动三件套：

```bash
cd /Users/you/repos/dsh-cron
bash scripts/setup-deps.sh          # 链接 @deepseek-ai/dsh-tools 等到仓库 node_modules

# 符号链接到桌面端加载的 fallback 目录
mkdir -p "$HOME/.dsh/profiles/node_modules/@dsh"
ln -sfn /Users/you/repos/dsh-cron "$HOME/.dsh/profiles/node_modules/@dsh/cron"
```

然后再在 profile 配置文件 `$HOME/.dsh/profiles/web/cordis.patch.yml` **追加**：

```yaml
- insert:
    - id: cron
      name: '@dsh/cron'
      config:
        timezone: Asia/Shanghai
```

最后重启应用。

> 注意：只有走到"手动三件套"这一分支才需要 `setup-deps.sh`。标准 bundle 安装**不需要**它。

---

## 更新插件

```bash
dsh plugin --profile web update @dsh/cron
```

（桌面端在 Plugins 页点 Update；本地 clone 用 `git -C /Users/you/repos/dsh-cron pull` 后重启。）

---

## 常见问题（FAQ）

**Q：日志报 `Cannot find package '@deepseek-ai/...' imported from .../dsh-cron/lib/index.js`**
A：标准 bundle 安装的插件运行期依赖由 harness 的共享 fallback 解析，正常不会报这个。若遇到，通常是本地目录安装在隔离 DSH 下解析不到框架依赖——回到上文「替代路径·手动三件套」跑一次 `setup-deps.sh` 再重启。

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
A：`dsh plugin --profile web remove @dsh/cron`（桌面端在 Plugins 页移除）。若是手动三件套装的，删掉符号链接 `rm "$HOME/.dsh/profiles/node_modules/@dsh/cron"` 并从 `cordis.patch.yml` 去掉那段，最后重启。任务表文件（`$HOME/.dsh/cron/jobs.json`）可以留着（重新安装后任务还在），想彻底清掉就一并删除。

---

## 数据存放位置

| 内容 | 位置 |
|---|---|
| 任务表 | `$HOME/.dsh/cron/jobs.json` |
| 每次运行的会话记录 | `$HOME/.dsh/sessions/...`（与普通会话同目录） |
| 浏览器 UI 静态资源 | 由插件在 harness 内 serve：`/plugins/@dsh/cron/client.js` |
