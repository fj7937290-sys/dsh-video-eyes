# video-eyes

给纯文本模型一双「看视频」的眼睛。

模型不能读视频。这个工具把视频拆成两样模型能读的东西，并按同一条时间轴对齐：

1. **带时间码的抽帧总览图** —— 每隔 N 秒（可调，0.1–10 秒）取一帧，把每帧的真实时间码烧录在画面左上角，再按播放顺序拼成一张网格图（contact sheet），一页最多 `cols × rows` 格。
2. **带时间戳的语音转写** —— 抽出音轨，交给听脑（iTingnao）转写成逐句台词。

每页图都自动附上「这一页时间段里说了什么」，于是「画面」和「语音」天然对齐。

---

## 两种形态

| 形态 | 位置 | 给谁用 |
|---|---|---|
| **通用 skill** | `.dsh/skills/video-eyes/` | 任何 agent（Claude Code、Codex、Cursor、自建脚本）。纯 Node + ffmpeg，无第三方依赖 |
| **DSH 插件** | `.dsh-video-eyes/`（已装进 profile） | DeepSeek Harness。注册 `vision_video` / `vision_video_transcript` 两个工具，模型直接调用，拼图以图片形式进入对话 |

两者共用同一套抽帧与转写逻辑，产物格式一致。

---

## 通用 skill 用法

```bash
# 一条龙
node .dsh/skills/video-eyes/scripts/video-eyes.mjs run demo.mp4 --interval 0.5

# 只出图
node .dsh/skills/video-eyes/scripts/video-eyes.mjs frames demo.mp4 --interval 1

# 只看台词
node .dsh/skills/video-eyes/scripts/video-eyes.mjs transcribe demo.mp4
```

输出的 JSON 里：

```jsonc
{
  "video":   { "durationSec": 8.02, "width": 640, "height": 360, "fps": 30, "hasAudio": true },
  "sampling":{ "interval": 0.5, "totalFrames": 16, "sheetCount": 1, "artifactDir": "…" },
  "sheets":  [ { "page": 1, "path": "…/sheet-01.jpg", "from": "00:00.0", "to": "00:08.0",
                 "lines": [ { "t": "00:01.5", "s": "张三", "x": "大家好" } ] } ],
  "transcript": { "status": "completed", "recordId": 13000858, "text": "…" }
}
```

拿到 `sheets[].path` 后交给视觉能力看即可；时间码就是该帧在视频里的位置。

---

## DSH 插件用法

模型侧直接调用：

```
vision_video(path="D:\\videos\\demo.mp4", interval=0.5)
```

- 拼图会作为图片进入对话（每页前附带该页台词）
- 返回里带 `attachmentId`，可继续交给 `vision_describe` 做深度分析
- 转写没跑完时用 `vision_video_transcript(record_id=...)` 取回

### 输出目录

插件默认把产物写到**工作区**的 `.dsh-video-eyes/`（由 profile 的 `cordis.patch.yml` 里 `artifactDir` 指定）。

> 注意：DSH Host 进程的 `cwd` 是 `C:\Users\asd\.dsh`，而它 spawn 的 ffmpeg 子进程无法写入该目录。所以 `artifactDir` 必须指向工作区；插件会依次尝试 `artifactDir` → `cwd/.dsh-video-eyes` → 系统临时目录，用第一个真正能写出文件的。

---

## 依赖

| 依赖 | 说明 |
|---|---|
| Node ≥ 18 | 插件与 CLI 都用原生 `fetch` / `FormData` |
| ffmpeg | 唯一的硬依赖。本机已有：`_tools/pylibs/imageio_ffmpeg/binaries/ffmpeg-win64-v4.2.2.exe`（插件内另带一份 `bin/ffmpeg.exe`） |
| 听脑 API Key | 仅转写需要。`ITINGNAO_API_KEY`（Windows 下会读用户级环境变量）或 `--api-key` |

---

## 设计要点

- **一条 ffmpeg 命令搞定抽帧+时间码+拼图**：`fps → scale → drawtext → tpad → tile`。不引入 sharp/PIL 之类图像库，装好 ffmpeg 就能跑。
- **时间码来自 `%{pts}`**，是解码后的真实时间戳，不是计数器，所以变速/丢帧视频也对得上。
- **尾部残页补黑格**（`tpad stop_mode=add`），不会把最后一帧重复十几遍造成误读。
- **分页失败会明说**：页数超过 `max-sheets` 时报错并算出「interval 至少要多少」或「max-sheets 至少要多少」。
- **转写失败不影响出图**：音频/网络/账号任何一环出问题，`transcript.status` 会写清原因，拼图照常可用。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| `No usable ffmpeg found` | ffmpeg 不在 PATH。设 `VIDEO_EYES_FFMPEG` 或传 `--ffmpeg <path>` |
| `transcript.status = unavailable` | 没有听脑 Key。抽帧不受影响 |
| `transcript.status = empty` | 视频里没有人声（纯音乐/静音），正常结果 |
| `transcript.status = processing` | 转写还没好。用 `transcript <recordId>` 再取，或加大 `--wait` |
| `would need N sheets but --max-sheets is M` | 按报错里的建议调大 interval 或 max-sheets |
| 拼图全黑 | 视频尾部不满一页时的补位格，正常；若整页全黑说明该段视频本来就是黑的 |
