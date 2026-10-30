# 详细工作流与排错

## 一次完整的视频分析

### 1. 先探底

```bash
node scripts/video-eyes.mjs frames demo.mp4 --interval 10 --max-sheets 4 --out ./_v
```

用最大间隔先出 1 页，确认：文件能读、方向对不对、是录屏还是真人、大概多长。这一步几乎不花时间，却能避免用错间隔重跑。

### 2. 按上表选间隔，正式采样

```bash
node scripts/video-eyes.mjs run demo.mp4 --interval 0.5 --out ./_v
```

JSON 里确认 `sampling.sheetCount` 与 `transcript.status`。

### 3. 看图

把 `sheets[].path` 逐页交给视觉能力：

- 多模态模型：直接读图
- 纯文本模型：用你的视觉桥（如 DSH 的 `vision_describe`、或任意 OCR/描述工具）
- 一次给 1–4 张，问的具体一点比问「这张图是什么」有效得多

问法示例：

> 这是视频第 1 页（00:00.0–00:08.0）的抽帧总览，4×4 排列，按从左到右、从上到下是时间顺序。请按格描述画面变化，并指出第一次出现「图表」是在第几格。

### 4. 对时间轴

第 `p` 页（从 1 开始）第 `k` 格（从 0 开始，行优先）的时间：

```
t = (p - 1) × pageSize × interval + k × interval
```

其中 `pageSize = columns × rows`，都在 JSON 的 `sampling` 里。

### 5. 图文对照

`sheets[].lines` 已经是这一页时间段内的台词。若需要更细：

```bash
node scripts/video-eyes.mjs transcript 13000858 --wait 60
```

拿到逐句 `startSec`，与上面算出的 `t` 对齐，就能回答「说到这句话时画面在干什么」。

### 6. 需要细节时

对某个 10 秒片段用更小间隔重跑：

```bash
node scripts/video-eyes.mjs frames demo.mp4 --interval 0.1 --max-sheets 4 --out ./_v_detail
```

但注意：工具从**视频开头**采样，不支持只截中间一段。需要精确片段时，先用 ffmpeg 裁剪：

```bash
ffmpeg -ss 00:01:20 -to 00:01:30 -i demo.mp4 -c copy clip.mp4
node scripts/video-eyes.mjs frames clip.mp4 --interval 0.1 --out ./_v_clip
```

`clip.mp4` 的时间戳从 0 开始，所以换算时要加上 `00:01:20` 的偏移。

---

## 产物目录结构

```
<out>/<视频名>-<随机后缀>/
  sheet-01.jpg    第 1 页
  sheet-02.jpg    第 2 页（如果超过一页）
  audio.mp3       抽出的音轨（仅 run / audio / transcribe）
```

`sheet-*.jpg` 是最多 1920×1080 左右的 JPEG（单格宽度由 `--width` 决定，竖屏视频会自动压缩）。

---

## 常见问题

### 时间码不准？

时间码取自 ffmpeg 的 `%{pts:hms}`，是解码后的真实显示时间。如果视频有可变帧率（VFR），`fps` 滤镜会按目标帧率重采样，时间码仍是正确的真实时间，但某一格可能对应到最近的一帧而非精确时刻——误差不超过一个 `1/fps`。

### 页数算出来和实际不一样？

页数 = `ceil(总帧数 / 每页格数)`，总帧数 = `floor(时长 / interval)`。最后一页不满时会补黑格，所以实际产出页数与计算值一致。

### 转写是分段还是整段？

听脑返回的是逐句数组（`data` 字段），每句带 `beginTime`（毫秒）。本工具归一化成 `startSec`（秒）。若上游给的是秒而不是毫秒，脚本会用视频时长做一次启发式判断。

### 账号状态 90

听脑里有些文件开了「非自动转写」，`status = 90` 表示还没开始转。工具会自动调一次 `/api/record/reset_handle` 触发，无需手工处理。

### 想批量处理

```bash
for f in *.mp4; do
  node scripts/video-eyes.mjs run "$f" --interval 1 --out ./_v
done
```

产物在 `_v/<各视频名>-<后缀>/` 下，互不覆盖。
