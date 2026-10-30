---
name: video-eyes
description: |
  让纯文本模型读懂视频：按 0.1–10 秒的可调间隔抽帧，把每帧的真实时间码烧进画面并拼成总览图；同时提取音轨转写成带时间戳的台词，图与台词按同一条时间轴对齐。

  当以下情况时使用此 Skill：
  (1) 用户给了视频文件并问「里面讲了什么 / 发生了什么 / 帮我总结」
  (2) 需要定位某个画面出现在第几秒
  (3) 需要把画面和语音对照分析（谁在什么时候说了什么、说到哪句时画面变了）
  (4) 模型本身不能读视频、不能听音频
whenToUse: 需要分析本地视频的画面变化、内容或对应台词时
metadata: {"video-eyes": {"requires": {"ffmpeg": true, "node": ">=18"}, "optionalEnv": ["ITINGNAO_API_KEY", "VIDEO_EYES_VISION_BASE_URL", "VIDEO_EYES_VISION_API_KEY", "VIDEO_EYES_VISION_MODEL"]}}
---
# Video Eyes

让纯文本模型读懂视频：**按可调间隔抽帧 → 拼成带时间码的总览图 → 提取音轨转写成带时间戳的台词 → 图与台词按同一条时间轴对齐**。

适用于任何 agent（Claude Code / Codex / Cursor / DSH / 自建脚本），只依赖 Node 18+ 和一个 ffmpeg 可执行文件。

---

## 什么时候用

- 用户给了一个视频文件，问「里面讲了什么 / 发生了什么 / 给我总结一下」
- 需要从视频里定位某个画面出现的时间点
- 需要把视频的**画面**和**语音**对照着分析（谁在什么时候说了什么、说到哪句时画面切了）
- 模型本身不能读视频、不能听音频

不要用它来做：精确到帧的画面比对（用逐帧导出）、音频编辑、视频转码。

---

## 核心概念

一次 `run` 产出四样东西，全部按时间轴对齐：

| 产物 | 说明 |
|---|---|
| **总览图（contact sheet）** | 每页 `cols × rows` 格，按播放顺序排列；每格左上角烧录了该帧原始时间码（`HH:MM:SS.mmm`），空白格为黑底（视频尾部不满一页时） |
| **画面描述（可选）** | 配置了视觉端点时，逐页生成文字描述，让纯文本模型也能"看懂" |
| **时间轴映射** | 第 N 页覆盖 `from – to` 时间段，第 k 格对应 `from + k × interval` |
| **台词（带时间戳）** | 每句都有 `startSec`，来自听脑转写 |
| **图文对照** | 每页自动附上「该页时间段内说出的台词」 |

---

## 快速开始

```bash
# 一条龙：抽帧 + 拼图 + 提取音频 + 转写（默认 0.5 秒一帧）
node scripts/video-eyes.mjs run "/absolute/path/demo.mp4"

# 只要图，不要音频（更快、不联网）
node scripts/video-eyes.mjs frames "/absolute/path/demo.mp4" --interval 1

# 只要音频与转写
node scripts/video-eyes.mjs transcribe "/absolute/path/demo.mp4"

# 查已有转写任务的进度/全文
node scripts/video-eyes.mjs transcript 13000858 --wait 60

# 自定义网格与输出目录
node scripts/video-eyes.mjs run demo.mp4 --interval 0.5 --cols 4 --rows 4 --out ./_video
```

输出是 **JSON（stdout）**，任何 agent 都能解析；错误走 stderr 且退出码非 0。

---

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--interval <秒>` | `0.5` | 抽帧间隔，**0.1–10**。越小越细，越大覆盖时间越长 |
| `--cols <n>` | `4` | 每页列数，2–8 |
| `--rows <n>` | `4` | 每页行数，1–8 |
| `--max-sheets <n>` | `4` | 最多几页。超出会报错并给出可用的 interval / max-sheets 建议 |
| `--width <px>` | `480` | 单格宽度。竖屏视频会自动压缩以控制总高度 |
| `--out <dir>` | `<cwd>/.video-eyes` | 产物目录 |
| `--no-audio` | 关 | 跳过音频提取与转写 |
| `--describe` / `--no-describe` | 配了视觉端点则开启 | 用视觉模型逐页描述画面 |
| `--vision-base-url` | `$VIDEO_EYES_VISION_BASE_URL` | OpenAI 兼容端点，如 `https://api.example.com/v1` |
| `--vision-model` | `$VIDEO_EYES_VISION_MODEL` | 接受图像输入的模型 id |
| `--vision-api-key` | `$VIDEO_EYES_VISION_API_KEY` | 该端点的 Bearer token |
| `--wait <秒>` | `90` | 转写轮询上限，超时返回 `status: processing` + recordId |
| `--ffmpeg <path>` | 自动探测 | 指定 ffmpeg 二进制 |
| `--api-key <key>` | `$ITINGNAO_API_KEY` | 听脑 API Key |

---

## 间隔怎么选

页数 = `ceil(时长 / interval / (cols × rows))`，必须 ≤ `max-sheets`。

| 视频时长 | 推荐 interval | 得到 |
|---|---|---|
| ≤ 30 秒 | `0.5`（默认） | 1–2 页，细节完整 |
| 1 分钟 | `1` | 4 页 |
| 2–3 分钟 | `2` | 4–8 页 |
| 5 分钟 | `5` | 4 页 |
| 10 分钟以上 | `10`（上限） | 4 页左右，只抓大节点 |

间隔越小，单页覆盖越短、细节越清楚；间隔越大，越能一眼看完整段视频的节奏。**先按上表跑一遍粗看，再对可疑时间段用更小间隔重跑**。

---

## 拿到结果之后

1. 先读 JSON 里的 `video` + `sampling`，确认视频和采样参数符合预期。
2. **看画面**：
   - `describe.status === "completed"` → `sheets[].description` 已经是这一页的画面描述，直接读即可，**不需要**再调视觉工具。
   - `describe.status === "unavailable"` → 没配视觉端点。把 `sheets[].path` 交给你的视觉能力（多模态模型直接读；纯文本模型用 `vision_describe` / OCR 之类的工具）。每张图按时间顺序排列，左上角时间码就是该帧在视频里的位置。
3. **看台词**：`sheets[].lines` 是这一页时间段内的台词；`transcript.text` 是全文。
4. **对照分析**：把「第几页第几格」换算成时间（`from + k × interval`），再与台词时间戳对齐，就能回答「说到 X 的时候画面是什么」。

---

## 限制与注意

- **需要 ffmpeg**：找不到时会报错并列出探测过的路径。装 ffmpeg，或设 `VIDEO_EYES_FFMPEG`，或传 `--ffmpeg`。
- **画面描述是可选的**：不配视觉端点也能用，只是要自己看图。配了 `VIDEO_EYES_VISION_BASE_URL` + `VIDEO_EYES_VISION_MODEL` 就会自动逐页描述。端点必须是 OpenAI 兼容的 `/chat/completions`，且模型接受 `image_url`。
- **转写需要听脑 API Key**：没有 Key 时抽帧仍然可用，只是 `transcript.status` 为 `unavailable`。Key 从 `--api-key` 或环境变量 `ITINGNAO_API_KEY`（Windows 下也会读用户级环境变量）获取。
- **转写是异步的**：短音频通常 30 秒内完成；`--wait` 超时会返回 `processing` 和 `recordId`，稍后用 `transcript <recordId>` 再取。
- **无人声视频**（纯音乐/静音）会返回 `status: empty`，这是正常结果，不是故障。
- **隐私**：启用转写会把音频上传到听脑服务。敏感视频请用 `--no-audio` 或 `frames`。
- **长视频很慢**：抽帧是整段解码，10 分钟视频可能要几十秒；`--interval` 调大不会让它变快（ffmpeg 仍需解码），但会减少产物数量和 vision 消耗。

---

## 相关文件

- `scripts/video-eyes.mjs` — 全部实现，单文件、无第三方依赖
- `references/workflow.md` — 详细的逐步工作流与排错
- `README.md` — 面向人的说明
