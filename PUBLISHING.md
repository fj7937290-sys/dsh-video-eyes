# 发布到 DSH 插件市场

本插件的本地安装已经完成，`插件 → 已安装` 里能看到它。要出现在市场的**发现/搜索**里，还差一次收录。

## 市场是怎么收录的

`dshmarket` 每次打开都实时拉 [`awesome-dsh-plugin.com/plugins.json`](https://awesome-dsh-plugin.com/plugins.json)，数据源是精选列表仓库 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— **一个插件一个 YAML 文件**。

所以「发到市场」= **给 awesome-dsh-plugin 提一个收录 PR**，站点和市场通常一天内生效。市场应用本体（`dsh-market`）不接收插件条目。

## 硬门槛（缺一不可）

| 门槛 | 状态 |
|---|---|
| GitHub **公开**仓库 | 待你创建 |
| 仓库 topic 含 `dsh-plugin` | 待你添加 |
| 仓库**创建满 1 天**（CI 检查 `MIN_AGE_DAYS = 1`） | 创建后要等 |
| `package.json` 声明 `dsh.bundle` | 已满足 |
| 仓库内有真实可用的代码 | 已满足（Host + Client） |

## 步骤

### 1. 建仓库并推送

仓库名建议与包名一致：`dsh-video-eyes`。本目录已经是 git 仓库且有一次提交（`bin/ffmpeg.exe` 已通过 `.gitignore` 排除）。

```sh
cd .dsh-video-eyes
gh repo create <你的用户名>/dsh-video-eyes --public --source . --remote origin --push
gh repo edit <你的用户名>/dsh-video-eyes --add-topic dsh-plugin
```

没有 `gh` 就在 GitHub 网页新建空仓库，然后：

```sh
git remote add origin https://github.com/<你的用户名>/dsh-video-eyes.git
git push -u origin main
```

再去仓库设置里添加 topic `dsh-plugin`。

### 2.（可选）发布 npm

不发也能上架 —— 列表里很多条目没有 npm 映射。发了的好处是市场能统计下载量并参与排序。

```sh
npm publish --access public
```

已经确认 `dsh-video-eyes` 这个包名在 npm 上**未被占用**。发布前请确认 `package.json` 里补上 `repository`（指向被收录的仓库），否则包与仓库不会关联：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你的用户名>/dsh-video-eyes.git" },
"homepage": "https://github.com/<你的用户名>/dsh-video-eyes#readme"
```

> 条目 YAML 里**不要**手写 `npm:` 字段 —— 映射由列表 CI 从 registry 自动采集，手写会被校验拒绝。

### 3. 提收录 PR

把 [`market/dsh-video-eyes.yml`](market/dsh-video-eyes.yml) 里的 `OWNER` 替换成你的 GitHub 用户名，然后：

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 新建分支，把文件放到 `data/plugins/<你的用户名>__dsh-video-eyes.yml`
   （**文件名必须等于 URL 的 slug**：`owner__repo`）
3. 提 PR（一个 PR 最多 3 条；不要手工改生成的 README）

条目内容已经按 `scripts/lib/entries.mjs` 的校验规则写好：

- `url` 必须是 `https://github.com/owner/repo`
- `name` 写成 `owner/repo` 时必须与 url 一致（写成裸显示名则不校验）
- `category` 取自固定集合，这里用 **`vision`**
- `description.en` 必需、单行；**含半角 `: ` 必须加引号**（已加）
- 只允许 `url` / `name` / `category` / `description` / `icon` / `tarball` 这几个键
- `icon` 若要填，必须是 GitHub 托管的 https 栅格图（png/jpg/jpeg/webp），不能用仓库内相对路径

### 4. 等 CI 合并

PR 依次检查：条目数 ≤ 3 → 仓库 `package.json` 有 `dsh.bundle` → 仓库满 1 天 → awesome-lint 与站点构建。合并后 `plugins.json` 由 CI 每日刷新，市场打开即能搜到。

用户看到的安装命令形如：

```sh
dsh plugin --profile web add github:<你的用户名>/dsh-video-eyes
```

## 已经为你准备好的

- `market/dsh-video-eyes.yml` —— 收录条目（替换 `OWNER` 即可）
- `screenshots.json` + `docs/` —— 商店截图（输出示例，1–8 张、仓库内相对路径）
- `package.json` —— 名称/描述/关键词/`engines.dsh`/`dsh.bundle`/`dsh.client` 齐备，`files` 不含 64MB 的 ffmpeg
- `.gitignore` —— 排除本地 ffmpeg 与产物
- git 仓库已初始化并提交

## 注意

- **`bin/ffmpeg.exe` 不进仓库**（64MB，且不同平台二进制不同）。别人克隆后需要自备 ffmpeg：
  - 装到 PATH，或
  - 设 `FFMPEG_PATH` 环境变量，或
  - 在插件配置里设 `ffmpegPath`
- 发布版没有内置 ffmpeg，这是有意的：npm 包保持 20 多 KB，而不是 64MB。
