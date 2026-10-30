# 从零发布：GitHub + DSH 插件市场

这份文档假设你什么账号状态都没有：没有 GitHub 仓库、没登录 npm、没装 `gh`。
按顺序做完，插件会出现在 DSH 插件市场的**发现/搜索**里。

---

## 0. 先分清你要发布的是什么

这个仓库里有两样东西：

| 形态 | 位置 | 发布途径 |
|---|---|---|
| **DSH 插件** | 仓库根目录 | GitHub 仓库 + 插件市场收录 PR |
| **通用 skill** | `skills/video-eyes/` | 跟着同一个仓库走，用户复制到自己的技能目录 |

**关键认知**：DSH 插件市场只收录**插件**，没有独立的"技能市场"。skill 不是通过市场分发的，它靠仓库克隆 + 复制，或者作为插件仓库的附带内容。

所以下面只有一条发布主线：先把仓库推上 GitHub，再让插件市场收录这个仓库。

---

## 1. 前置准备（约 5 分钟）

### 1.1 你需要

- 一个 GitHub 账号（免费即可）
- 本机已装 Git（已确认：`git version 2.55.0.windows.5`）

### 1.2 配置 git 身份（只需一次）

现在的提交用的是我临时填的占位身份，请换成你自己的：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"
```

验证：

```powershell
git config --global user.name
git config --global user.email
```

### 1.3（可选，但强烈建议）安装 GitHub CLI

装了 `gh`，后面的建仓库、加 topic、提 PR 都能一条命令完成；不装就走网页，步骤我在下面也写全了。

```powershell
winget install --id GitHub.cli
```

装完**重开一个终端**（让 PATH 生效），然后登录：

```powershell
gh auth login
```

选择：`GitHub.com` → `HTTPS` → `Login with a web browser`，按提示在浏览器里输入一次性代码。

验证：

```powershell
gh auth status
```

---

## 2. 建仓库并推送代码

### 方式 A：网页建（不需要 gh）

1. 浏览器打开 <https://github.com/new>
2. **Repository name** 填：`dsh-video-eyes`
3. 选 **Public**（插件市场只接受公开仓库）
4. **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license"——本地仓库里已经有了，勾了会冲突
5. 点 **Create repository**
6. 打开终端执行：

```powershell
cd C:\Users\asd\OneDrive\Desktop\ds\.dsh-video-eyes
git remote add origin https://github.com/<你的用户名>/dsh-video-eyes.git
git branch -M main
git push -u origin main
```

推送时会要求认证：

- **弹窗登录**：选 "Sign in with your browser"，按提示授权即可
- **或者用 Personal Access Token**：
  1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
  2. Repository access 选 "All repositories" 或指定这个仓库
  3. Permissions 里勾 **Contents: Read and write**
  4. 生成后复制 `github_pat_...`，密码框里粘贴它（用户名填你的 GitHub 用户名）

### 方式 B：gh CLI（两条命令）

```powershell
cd C:\Users\asd\OneDrive\Desktop\ds\.dsh-video-eyes
gh repo create <你的用户名>/dsh-video-eyes --public --source . --remote origin --push
```

### 2.1 验证推送成功

浏览器打开 `https://github.com/<你的用户名>/dsh-video-eyes`，应该能看到：

- 根目录有 `package.json`、`index.js`、`client.js`、`cordis.patch.yml`、`README.md`
- 有一个 `skills/video-eyes/` 目录
- 有一个 `docs/` 目录（两张示例图）
- **没有** `bin/ffmpeg.exe`（被 `.gitignore` 排除了，这是有意的）

---

## 3. 给仓库加 topic（硬性门槛）

插件市场的 CI 会检查仓库是否带 `dsh-plugin` 这个 topic，没有直接拒。

**网页操作**：

1. 打开仓库首页
2. 右侧 **About** 区域，点旁边的 ⚙️（齿轮图标）
3. 在 **Topics** 输入框里输入 `dsh-plugin`，回车确认
4. 点 **Save changes**

**gh 操作**：

```powershell
gh repo edit <你的用户名>/dsh-video-eyes --add-topic dsh-plugin
```

---

## 4. 等满 1 天（这是硬门槛，绕不过去）

列表仓库的 CI 有个 `MIN_AGE_DAYS = 1` 检查：**仓库创建后必须满 1 天**，才接受收录 PR。

也就是说：

- 你今天（比如 18:00）建好仓库
- **明天 18:00 之后**才能提 PR
- 提前提了 CI 会报 `repository is 0.0 days old (needs 1)`

等待期间可以做的：
- 补 `package.json` 的 `repository` / `homepage`（见第 7 节）
- 在自己的 DSH 里从 GitHub 装一次，确认没问题：
  ```powershell
  dsh plugin --profile web add github:<你的用户名>/dsh-video-eyes
  ```

---

## 5. 提收录 PR（核心步骤）

### 5.1 准备条目文件

编辑 `market/dsh-video-eyes.yml`，把两处 `OWNER` 换成你的 GitHub 用户名：

```yaml
url: https://github.com/<你的用户名>/dsh-video-eyes
name: <你的用户名>/dsh-video-eyes
category: vision
description:
  en: '...'
  zh: '...'
```

**不要改别的字段**，尤其不要加 `npm:` —— 列表 CI 会从 registry 自动采集 npm 映射，手写会被校验拒绝。

### 5.2 Fork 目标仓库

浏览器打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

点右上角 **Fork** → Create fork。

### 5.3 在你的 fork 里新增一个文件

路径**必须**是：

```
data/plugins/<你的用户名>__dsh-video-eyes.yml
```

注意是**两个下划线** `__` 分隔 owner 和 repo，因为目标文件名由 URL 的 slug 生成（`slugFor('https://github.com/o/r')` → `o__r`）。

**网页操作**：

1. 进入你的 fork
2. 点进 `data` → `plugins` 目录
3. 右上 **Add file** → **Create new file**
4. 文件名填：`<你的用户名>__dsh-video-eyes.yml`
5. 内容粘贴 5.1 里改好的 YAML
6. 底部 **Commit changes**

**命令行操作**：

```powershell
cd $env:TEMP
git clone https://github.com/<你的用户名>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
# 把改好的 yml 复制进去
Copy-Item C:\Users\asd\OneDrive\Desktop\ds\.dsh-video-eyes\market\dsh-video-eyes.yml `
  "data\plugins\<你的用户名>__dsh-video-eyes.yml"
git checkout -b add-dsh-video-eyes
git add .
git commit -m "Add dsh-video-eyes"
git push -u origin add-dsh-video-eyes
```

### 5.4 创建 PR

回你的 fork 页面，会看到黄色提示条 **"Compare & pull request"**，点它。

- **标题**：`Add dsh-video-eyes`
- **正文**：简单说明插件做什么、依赖什么（可选，但维护者喜欢看）
- 确认 base 仓库是 `awesome-dsh-plugin/awesome-dsh-plugin`、base 分支 `main`
- 点 **Create pull request**

**gh 方式**：

```powershell
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin `
  --head <你的用户名>:add-dsh-video-eyes `
  --title "Add dsh-video-eyes" `
  --body "Video sampling for text-only agents: timecoded contact sheets + timestamped transcript, self-describing via the host's image-capable model."
```

### 5.5 CI 会检查什么

| 检查 | 说明 |
|---|---|
| 条目数 ≤ 3 | 一个 PR 最多加 3 条 |
| `package.json` 有 `dsh.bundle` | 已有 |
| 仓库创建满 1 天 | 见第 4 节 |
| `awesome-lint` + 站点构建 | 双语一致性、`description.en` 非空、单行等 |
| 不改生成的 README | 只加 `data/plugins/*.yml`，别动 README |

**失败怎么办**：CI 会在 PR 里给出具体原因，你在同一个分支上 push 修复即可，PR 会自动更新。

---

## 6. 合并之后

- 站点（awesome-dsh-plugin.com）和 `plugins.json` 由 CI **每日刷新**
- 市场（Settings → 插件市场）打开时实时拉取，所以合并后通常一天内就能搜到
- 用户看到的安装命令：
  ```sh
  dsh plugin --profile web add github:<你的用户名>/dsh-video-eyes
  ```

---

## 7.（可选）发布到 npm

不发也能上架，但发了之后市场能显示下载量、参与排序。

### 7.1 先补 package.json

在发布前，把仓库地址填进去（否则 npm 包和 GitHub 仓库不会关联）：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/<你的用户名>/dsh-video-eyes.git"
},
"homepage": "https://github.com/<你的用户名>/dsh-video-eyes#readme",
"bugs": {
  "url": "https://github.com/<你的用户名>/dsh-video-eyes/issues"
}
```

### 7.2 发布

```powershell
cd C:\Users\asd\OneDrive\Desktop\ds\.dsh-video-eyes
npm login          # 浏览器授权
npm publish --access public
```

**包名 `dsh-video-eyes` 已确认在 npm 上未被占用**（registry 返回 404）。

### 7.3 注意

- 包体积约 **23.7 kB**（打包后），**不含 64MB 的 ffmpeg** —— 这是有意的，`files` 白名单里没有 `bin/`。
- 所以别人从 npm / GitHub 装插件后，**需要自备 ffmpeg**：
  - 装到 PATH，或
  - 设环境变量 `FFMPEG_PATH`，或
  - 在插件配置里设 `ffmpegPath`
- **条目里不要写 `npm:` 字段**，映射由 CI 从 registry 采集。

---

## 8. skill 怎么分发

`skills/video-eyes/` 跟着仓库走。别人要用，有两种方式：

**A. 从仓库复制（推荐）**

```powershell
# 克隆后复制到自己的工作区技能目录
git clone https://github.com/<你的用户名>/dsh-video-eyes.git
Copy-Item -Recurse .\dsh-video-eyes\skills\video-eyes `
  C:\你的工作区\.dsh\skills\video-eyes
```

**B. 在 DSH 里直接用**

DSH 的 skill 扫描根是工作区的 `.dsh/skills/`。复制进去后**无需重启**就会出现在技能目录里（文件系统 provider 会监视目录）。

```powershell
node C:\你的工作区\.dsh\skills\video-eyes\scripts\video-eyes.mjs run demo.mp4 --interval 0.5
```

**注意**：skill 需要自己配视觉端点才能识图：

```powershell
$env:VIDEO_EYES_VISION_BASE_URL = "https://api.example.com/v1"
$env:VIDEO_EYES_VISION_MODEL = "某个支持图像的模型"
$env:VIDEO_EYES_VISION_API_KEY = "sk-..."
```

不配也能用，只是要自己看图（`describe.status` 会显示 `unavailable` 并说明原因）。

---

## 9. 常见问题

### Q: `git push` 报 `Authentication failed`

用 Personal Access Token 代替密码，或改用 `gh auth login` 后走 HTTPS。

### Q: CI 说 `repository is 0.0 days old (needs 1)`

仓库创建不满 1 天。等够时间再 push 一个新 commit 触发重跑，或重新提 PR。

### Q: CI 说 YAML 解析失败／`invalid YAML`

最常见原因：`description.en` 里出现了半角 **`: `**（冒号+空格）。给那一行值加单引号即可。中文全角冒号「：」不受影响。

### Q: CI 说 `filename must match the url`

文件名必须是 `owner__repo.yml`（两个下划线），且 owner/repo 与 `url` 字段完全一致。

### Q: CI 说 `unknown field "npm"`

删掉 `npm:` 字段。只允许 `url` / `name` / `category` / `description` / `icon` / `tarball`。

### Q: 想把图标也放进市场卡片

条目里的 `icon` 必须是 **GitHub 托管的 https 栅格图**（`raw.githubusercontent.com` 等），不能写仓库内相对路径。例如仓库里的 `icon.svg` 是 SVG，不符合要求；需要一张 png/jpg 推到仓库后，用它的 raw 链接。

### Q: 市场里搜不到

- 确认 PR 已合并
- 确认 `plugins.json` 已刷新（CI 每日一次）
- 市场面板里有缓存，关掉重开

### Q: 我想先在自己机器上装一遍验证

```powershell
dsh plugin --profile web add github:<你的用户名>/dsh-video-eyes
```

装完重启 `dsh web`，`read_video` 工具就会出现。
