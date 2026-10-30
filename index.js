/**
 * dsh-video-eyes — Video sampling for text-only agents.
 *
 * Two capabilities on one timeline:
 *  - frame sheets: ffmpeg samples the video at a configurable interval (0.1–10s),
 *    burns each frame's timecode into the picture, and tiles them into contact
 *    sheets in playback order;
 *  - speech transcript: ffmpeg extracts the audio track, which is uploaded to
 *    iTingnao and transcribed into timestamped sentences.
 *
 * Frame sheets are committed through the attachment service, so they enter the
 * conversation as images; the tool result additionally pairs each sheet with the
 * transcript lines spoken during that sheet's time window.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  ffmpegPath: '',
  defaultInterval: 0.5,
  minInterval: 0.1,
  maxInterval: 10,
  columns: 4,
  rows: 4,
  cellWidth: 480,
  maxSheets: 4,
  maxSheetsCap: 24,
  jpegQuality: 3,
  enableTranscribe: true,
  enableDescribe: true,
  visionProvider: '',
  visionModel: '',
  itingnaoApiKey: '',
  itingnaoBaseUrl: 'https://api.itingnao.com',
  transcribeTimeoutMs: 100000,
  pollIntervalMs: 2500,
  ffmpegTimeoutMs: 300000,
  maxTranscriptChars: 14000,
  artifactDir: '',
  keepArtifactDirs: 20,
}

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/arial.ttf',
]

/** sheet absolute path -> ImageAttachmentRef, read back by render(). */
const SHEET_REFS = new Map()
let cachedItingnaoKey

/**
 * Sampling interval chosen by the human in the composer slider, or null to use
 * the configured default. Kept in memory: it is a per-process UI preference, and
 * the client re-posts it on load so a restart simply falls back to config.
 */
let RUNTIME_INTERVAL = null
const INTERVAL_ROUTE = '/_dsh/video-eyes/interval'

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return `${pad2(minutes)}:${rest.toFixed(1).padStart(4, '0')}`
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  if (total < 60) return `${total.toFixed(1)}s`
  const minutes = Math.floor(total / 60)
  const rest = Math.round(total - minutes * 60)
  return `${minutes}分${pad2(rest)}秒`
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(rest)}`
  return `${pad2(minutes)}:${pad2(rest)}`
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeSettings(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    ...DEFAULTS,
    ...source,
    minInterval: DEFAULTS.minInterval,
    maxInterval: DEFAULTS.maxInterval,
  }
}

/* ------------------------------------------------------------------ ffmpeg */

function resolveFfmpeg(settings) {
  const tried = []
  const candidates = []
  if (settings.ffmpegPath) candidates.push(String(settings.ffmpegPath))
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  candidates.push(path.join(HERE, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  candidates.push(path.join(HERE, 'bin', 'ffmpeg.exe'))
  candidates.push('ffmpeg')

  for (const candidate of candidates) {
    if (!candidate) continue
    tried.push(candidate)
    if (candidate === 'ffmpeg') {
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-version'], {
          stdio: 'ignore',
          timeout: 15000,
          windowsHide: true,
        })
        return 'ffmpeg'
      } catch {
        continue
      }
    }
    if (!path.isAbsolute(candidate)) continue
    if (!existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['-hide_banner', '-version'], {
        stdio: 'ignore',
        timeout: 15000,
        windowsHide: true,
      })
      return candidate
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    `找不到可用的 ffmpeg。已尝试：${tried.join(' ; ')}。` +
      '请安装 ffmpeg，或在插件配置里设置 ffmpegPath 指向 ffmpeg 可执行文件。',
  )
}

function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, payload) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      fn(payload)
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          finish(reject, new Error(`${path.basename(bin)} 执行超时（${options.timeoutMs}ms）`))
        }, options.timeoutMs)
      : null

    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(reject, new Error('执行已取消'))
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
  })
}

async function probeVideo(ffmpeg, source, signal) {
  const { stderr } = await runProcess(ffmpeg, ['-hide_banner', '-i', source], {
    signal,
    timeoutMs: 60000,
  })

  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSec = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0

  const sizeMatch = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  const fpsMatch = /Video:.*?(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  const hasAudio = /Stream #\d+:\d+.*?Audio:/.test(stderr)
  const hasVideo = /Stream #\d+:\d+.*?Video:/.test(stderr)

  if (!hasVideo && !hasAudio) {
    throw new Error(`该文件既没有视频流也没有音频流：${source}（ffmpeg 输出：${stderr.trim().slice(0, 400)}）`)
  }
  if (!(durationSec > 0)) {
    throw new Error(`无法读取时长：${source}（ffmpeg 输出：${stderr.trim().slice(0, 400)}）`)
  }

  return {
    durationSec,
    width: sizeMatch ? Number(sizeMatch[1]) : null,
    height: sizeMatch ? Number(sizeMatch[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    hasVideo,
    hasAudio,
  }
}

function pickFont() {
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const rest = x % y
    x = y
    y = rest
  }
  return x || 1
}

/** ffmpeg fps filter expression for one frame every `interval` seconds. */
function fpsExpression(interval) {
  const denominator = Math.round(interval * 1000)
  const numerator = 1000
  const divisor = gcd(numerator, denominator)
  return `${numerator / divisor}/${denominator / divisor}`
}

function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:')
}

async function extractSheets(settings, ffmpeg, source, meta, plan, workDir, signal) {
  const { interval, columns, rows, cellWidth, quality } = plan
  const pageSize = columns * rows
  const realFrames = plan.totalFrames
  const remainder = realFrames % pageSize
  const padFrames = remainder === 0 ? 0 : pageSize - remainder
  const pattern = path.join(workDir, 'sheet-%02d.jpg')

  const font = pickFont()
  const fontSize = Math.max(14, Math.round(cellWidth / 20))

  const parts = [`fps=${fpsExpression(interval)}`, `scale=${cellWidth}:-2:flags=lanczos`]
  if (font) {
    parts.push(
      [
        'drawtext=fontfile=' + `'${escapeFilterPath(font)}'`,
        "text='%{pts\\:hms}'",
        'x=8',
        'y=8',
        `fontsize=${fontSize}`,
        'fontcolor=yellow',
        'box=1',
        'boxcolor=black@0.65',
        'boxborderw=6',
      ].join(':'),
    )
  }
  if (padFrames > 0) {
    parts.push(`tpad=stop_mode=add:stop_duration=${(padFrames * interval).toFixed(3)}:color=black`)
  }
  parts.push(`tile=${columns}x${rows}:padding=6:margin=6:color=black`)

  const filter = parts.join(',')
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-vf',
    filter,
    '-vsync',
    '0',
    '-q:v',
    String(quality),
    '-f',
    'image2',
    pattern,
  ]

  const result = await runProcess(ffmpeg, args, {
    signal,
    timeoutMs: settings.ffmpegTimeoutMs,
  })

  if (result.code !== 0) {
    throw new Error(`ffmpeg 抽帧失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 800)}`)
  }

  const names = (await readdir(workDir)).filter((name) => /^sheet-\d+\.jpg$/.test(name)).sort()
  if (names.length === 0) {
    throw new Error(`ffmpeg 未生成任何拼图：${result.stderr.trim().slice(0, 800)}`)
  }

  return names.map((name) => path.join(workDir, name))
}

async function extractAudio(settings, ffmpeg, source, workDir, signal) {
  const target = path.join(workDir, 'audio.mp3')
  const result = await runProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      target,
    ],
    { signal, timeoutMs: settings.ffmpegTimeoutMs },
  )

  if (result.code !== 0 || !existsSync(target)) {
    throw new Error(`ffmpeg 提取音轨失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 500)}`)
  }
  return target
}

/* --------------------------------------------------------------- iTingnao */

function readWindowsUserEnvironment(name) {
  if (process.platform !== 'win32') return undefined
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i').exec(output || '')
    return match ? match[1].trim() : undefined
  } catch {
    return undefined
  }
}

function resolveItingnaoKey(settings) {
  if (settings.itingnaoApiKey) return String(settings.itingnaoApiKey)
  if (process.env.ITINGNAO_API_KEY) return process.env.ITINGNAO_API_KEY
  if (cachedItingnaoKey) return cachedItingnaoKey
  const fromRegistry = readWindowsUserEnvironment('ITINGNAO_API_KEY')
  if (fromRegistry) {
    cachedItingnaoKey = fromRegistry
    return fromRegistry
  }
  return undefined
}

async function itingnaoRequest(settings, key, { method, apiPath, query, body, signal }) {
  const base = String(settings.itingnaoBaseUrl || DEFAULTS.itingnaoBaseUrl).replace(/\/+$/, '')
  const url = new URL(base + apiPath)
  if (query) {
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(name, String(value))
    }
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${key}`,
  }
  const init = { method, headers, signal }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json;charset=UTF-8'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(url, init)
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`听脑接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    throw new Error(`听脑请求失败 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  return data
}

async function uploadAudio(settings, key, audioPath, signal) {
  const signResponse = await itingnaoRequest(settings, key, {
    method: 'GET',
    apiPath: '/api/common/sign',
    query: { oss_dir: '' },
    signal,
  })
  if (Number(signResponse.code) !== 200 || !signResponse.data) {
    throw new Error(`获取听脑上传签名失败：${JSON.stringify(signResponse).slice(0, 300)}`)
  }

  const sign = signResponse.data
  const extension = path.extname(audioPath) || '.mp3'
  const objectKey = `${sign.dir}${Date.now()}-${Math.random().toString(16).slice(2, 10)}${extension}`
  const fileName = path.basename(audioPath)
  const bytes = await readFile(audioPath)

  const form = new FormData()
  form.append('key', objectKey)
  form.append('policy', sign.policy)
  form.append('OSSAccessKeyId', sign.accessid)
  form.append('success_action_status', '200')
  form.append('signature', sign.signature)
  form.append('name', fileName)
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), fileName)

  const upload = await fetch(sign.host, { method: 'POST', body: form, signal })
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '')
    throw new Error(`听脑 OSS 上传失败 HTTP ${upload.status}：${detail.slice(0, 300)}`)
  }

  return objectKey
}

async function createTranscribeTask(settings, key, objectKey, durationSec, signal) {
  const response = await itingnaoRequest(settings, key, {
    method: 'POST',
    apiPath: '/api/record/create',
    signal,
    body: {
      trans_type: 1,
      chat_num: 1,
      style: 2,
      file_source_type: 1,
      name: path.basename(objectKey),
      file_path: objectKey,
      file_long: formatClock(durationSec),
      scene_id: 1,
      source_channel: 2,
      meets_example_id: 0,
      parent_model: 0,
      is_knowledge: 0,
      knowledge_id: 0,
      folder_id: 0,
      file_oss_source: 0,
    },
  })

  const recordId = Array.isArray(response.data)
    ? response.data[0] && response.data[0].id
    : response.data && response.data.id
  if (!recordId) {
    throw new Error(`创建听脑转写任务失败：${JSON.stringify(response).slice(0, 300)}`)
  }
  return Number(recordId)
}

async function fetchRecordDetail(settings, key, recordId, signal) {
  const response = await itingnaoRequest(settings, key, {
    method: 'GET',
    apiPath: '/api/record/detail',
    query: { id: recordId, summary_new: '1' },
    signal,
  })
  if (Number(response.code) !== 200 || !response.data) {
    throw new Error(`读取听脑记录失败：${JSON.stringify(response).slice(0, 300)}`)
  }
  return response.data
}

async function triggerManualTranscribe(settings, key, recordId, signal) {
  await itingnaoRequest(settings, key, {
    method: 'POST',
    apiPath: '/api/record/reset_handle',
    signal,
    body: { id: recordId, privilege_type: 1 },
  })
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('执行已取消'))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('执行已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function normalizeSegments(raw, durationSec) {
  const list = Array.isArray(raw) ? raw : []
  const segments = []

  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text) segments.push({ text, startSec: null, endSec: null, speaker: '' })
      continue
    }
    if (typeof entry !== 'object') continue

    const text = String(
      entry.text ?? entry.content ?? entry.sentence ?? entry.words ?? entry.value ?? '',
    ).trim()
    if (!text) continue

    const begin = firstNumber(
      entry.beginTime,
      entry.begin_time,
      entry.startTime,
      entry.start_time,
      entry.start,
    )
    const end = firstNumber(entry.endTime, entry.end_time, entry.end)
    const speaker = String(entry.userName ?? entry.speaker ?? entry.user_name ?? '').trim()
    segments.push({ text, startSec: begin, endSec: end, speaker })
  }

  // iTingnao reports milliseconds; some payloads carry seconds instead.
  const starts = segments.map((segment) => segment.startSec).filter((value) => value !== null)
  if (starts.length > 0) {
    const maxStart = Math.max(...starts)
    const looksLikeSeconds = durationSec > 0 && maxStart <= durationSec * 1.5 + 5
    const divisor = looksLikeSeconds ? 1 : 1000
    for (const segment of segments) {
      if (segment.startSec !== null) segment.startSec = segment.startSec / divisor
      if (segment.endSec !== null) segment.endSec = segment.endSec / divisor
    }
  }

  return segments.filter((segment) => segment.text)
}

function joinSegmentText(segments) {
  const parts = []
  let previousSpeaker = null
  let buffer = []
  const flush = () => {
    if (buffer.length) parts.push(buffer.join(''))
    buffer = []
  }
  for (const segment of segments) {
    if (segment.speaker && segment.speaker !== previousSpeaker) {
      flush()
      if (segment.speaker) parts.push(`**${segment.speaker}**：`)
      previousSpeaker = segment.speaker
    }
    buffer.push(segment.text)
  }
  flush()
  return parts.join('')
}

async function runTranscription(settings, audioPath, durationSec, signal) {
  const key = resolveItingnaoKey(settings)
  if (!key) {
    return {
      status: 'unavailable',
      reason:
        '未配置 ITINGNAO_API_KEY：可在插件配置里设置 itingnaoApiKey，或把该变量加入用户环境变量后重启 DSH。',
      recordId: null,
      segments: [],
      text: '',
      summary: '',
    }
  }

  const objectKey = await uploadAudio(settings, key, audioPath, signal)
  const recordId = await createTranscribeTask(settings, key, objectKey, durationSec, signal)

  const deadline = Date.now() + Math.max(10000, Number(settings.transcribeTimeoutMs) || 100000)
  let triggered = false
  let detail = null
  let failure = ''

  while (Date.now() < deadline) {
    signal?.throwIfAborted?.()
    detail = await fetchRecordDetail(settings, key, recordId, signal)
    const status = Number(detail.status)
    const dataStatus = Number(detail.data_status)

    if (status === 90 && !triggered) {
      await triggerManualTranscribe(settings, key, recordId, signal)
      triggered = true
    } else if (status === 100 || status === -2 || dataStatus === 2) {
      failure = status === -2 ? '听脑账号权益受限，无法转写。' : '听脑转写失败。'
      break
    } else if (dataStatus === 1 || (status === 4 && Array.isArray(detail.data))) {
      break
    }

    await delay(Math.max(1000, Number(settings.pollIntervalMs) || 2500), signal)
  }

  const segments = normalizeSegments(detail?.data, durationSec)
  const summary = typeof detail?.meeting_summary === 'string' ? detail.meeting_summary.trim() : ''

  if (failure) {
    return { status: 'failed', reason: failure, recordId, segments, text: joinSegmentText(segments), summary }
  }
  if (segments.length === 0) {
    const finished = detail && (Number(detail.data_status) === 1 || Number(detail.status) === 4)
    return {
      status: finished ? 'empty' : 'processing',
      reason: finished
        ? '听脑未识别出语音内容（可能是纯音乐、静音或无人声）。'
        : '转写仍在进行，稍后用 vision_video_transcript 取回。',
      recordId,
      segments,
      text: '',
      summary,
    }
  }

  return { status: 'completed', recordId, segments, text: joinSegmentText(segments), summary }
}

/* ---------------------------------------------------------------- helpers */

function slugify(value) {
  return String(value || 'video')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'video'
}

/**
 * Ordered artifact roots. The Host process and the ffmpeg child it spawns may
 * run under different file restrictions, so callers try each root until one
 * actually accepts ffmpeg output rather than trusting the first writable mkdir.
 */
function artifactCandidates(settings) {
  const list = []
  if (settings.artifactDir) list.push(path.resolve(String(settings.artifactDir)))
  const cwd = process.cwd() || ''
  if (cwd && !cwd.includes(`${path.sep}node_modules${path.sep}`)) {
    list.push(path.join(cwd, '.dsh-video-eyes'))
  }
  list.push(path.join(os.tmpdir(), 'dsh-video-eyes'))
  return [...new Set(list)]
}

async function pruneArtifacts(root, keep) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(root, entry.name)
      try {
        const info = await stat(full)
        dirs.push({ full, mtime: info.mtimeMs })
      } catch {
        // ignore
      }
    }
    dirs.sort((left, right) => right.mtime - left.mtime)
    await Promise.all(dirs.slice(Math.max(1, keep)).map((dir) => rm(dir.full, { recursive: true, force: true })))
  } catch {
    // best effort
  }
}

function linesInWindow(segments, fromSec, toSec) {
  const lines = []
  for (const segment of segments) {
    if (segment.startSec === null) continue
    if (segment.startSec >= fromSec - 0.25 && segment.startSec < toSec) lines.push(segment)
  }
  return lines
}

/* ---------------------------------------------------------- peers & vision */

/**
 * Tool names are deliberately NOT prefixed with `vision_`.
 * dsh-vision-router wraps `tools.register` and claims every `vision_*` name as
 * its own tool, masking it from the model whenever its Vision mode is off. Using
 * that namespace would make these tools vanish for reasons that have nothing to
 * do with video, so we stay out of it entirely.
 */
const VIDEO_TOOL_NAME = 'read_video'
const TRANSCRIPT_TOOL_NAME = 'read_video_transcript'

/** Peers that share the visual surface with us, detected by their registered tools. */
function detectVisionPeers(ctx) {
  const peers = []
  try {
    if (ctx.tools.get('vision_describe')) peers.push('dsh-vision-router')
  } catch {
    // tools service unavailable
  }
  try {
    if (ctx.tools.get('browser_screenshot')) peers.push('dsh-builtin-browser')
  } catch {
    // ignore
  }
  return peers
}

const VISION_TARGET_CACHE = new Map()

/**
 * Choose a route that actually accepts image input: explicit config first, then
 * the session's own model, then any image-capable model a provider advertises.
 * Capability is verified through prepareCall, never assumed from a name.
 */
async function pickVisionTarget(ctx, settings) {
  const llm = ctx.get('llm')
  if (!llm) {
    return { error: '当前 Host 没有 llm 服务，无法自行识图；把 describe 设为 false 或安装一个视觉插件。' }
  }

  const explicit = []
  if (settings.visionProvider && settings.visionModel) {
    explicit.push({ provider: String(settings.visionProvider), model: String(settings.visionModel) })
  }

  // The session model is only a last resort: a text-only model fronted by another
  // vision plugin advertises `image` input but answers with a tool call instead of
  // a description. Native multimodal routes from the provider catalogs come first.
  const sessionModels = []
  try {
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const selection =
      agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
        ? agentDefaultModel.currentSelection()
        : null
    if (selection && selection.provider && selection.model) {
      sessionModels.push({ provider: selection.provider, model: selection.model })
    }
  } catch {
    // no default model service
  }

  const cacheKey = `${explicit.map((item) => `${item.provider}/${item.model}`).join('|')}#${settings.visionProvider || ''}#${sessionModels.map((item) => `${item.provider}/${item.model}`).join('|')}`
  if (VISION_TARGET_CACHE.has(cacheKey)) return VISION_TARGET_CACHE.get(cacheKey)

  const scanned = []
  try {
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider || !provider.id) continue
      try {
        const models = await llm.listModels(provider.id)
        for (const model of Array.isArray(models) ? models : []) {
          const modalities = model && model.inputModalities
          if (Array.isArray(modalities) && modalities.includes('image')) {
            scanned.push({ provider: provider.id, model: model.id })
          }
        }
      } catch {
        // provider exposes no catalog
      }
    }
  } catch {
    // registry unavailable
  }

  const seen = new Set()
  // Explicit config, then native multimodal catalog routes, then the session model.
  const candidates = [...explicit, ...scanned, ...sessionModels]
  for (const candidate of candidates) {
    const key = `${candidate.provider}/${candidate.model}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const prepared = await llm.prepareCall({ provider: candidate.provider, model: candidate.model })
      const modalities = prepared && prepared.inputModalities
      if (Array.isArray(modalities) && modalities.includes('image')) {
        const resolved = { provider: candidate.provider, model: candidate.model }
        VISION_TARGET_CACHE.set(cacheKey, resolved)
        return resolved
      }
    } catch {
      // route missing, unkeyed, or text-only
    }
  }

  const failure = {
    error:
      '找不到接受图像输入的模型。请在插件配置里设置 visionProvider / visionModel，' +
      '或为某个 provider 添加一个视觉模型；也可以把 describe 设为 false，改用自己的视觉工具看图。',
  }
  VISION_TARGET_CACHE.set(cacheKey, failure)
  return failure
}

async function describeSheet(llm, target, ref, sheet, signal) {
  const prompt = [
    `这是一张视频抽帧拼图（第 ${sheet.page} 页），按从左到右、从上到下的顺序是播放顺序，`,
    '每格左上角的黄色文字是该帧在视频里的真实时间码。',
    `本页覆盖 ${sheet.from} – ${sheet.to}。`,
    '请逐格描述：每格是什么（人物 / 界面 / 幻灯片 / 图表 / 字幕 / 场景），',
    '并指出明显的变化点（场景切换、换页、关键信息出现）。',
    '直接给结论，不要客套。如果某格是纯黑或空白，说明它多半是视频尾部补位，不用解读。',
  ].join('')

  let text = ''
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment: ref },
        ],
      },
    ],
    maxTokens: 900,
    signal,
  })

  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      throw new Error((chunk.reason.failure && chunk.reason.failure.message) || '视觉模型调用失败')
    }
  }

  const cleaned = text.trim()
  // A text-only model behind another vision plugin advertises image input but
  // answers with a tool call rather than a description. Treat that as a failure
  // instead of passing the raw call text off as what the sheet shows.
  if (/<tool_call>|<\|tool_call\|>|^\s*\{\s*"name"\s*:\s*"(vision_|read_)/i.test(cleaned)) {
    throw new Error(
      '该路由返回的是工具调用而不是画面描述，说明它不是真正的多模态模型；' +
        '请在插件配置里把 visionProvider / visionModel 指向一个原生支持图像的模型。',
    )
  }
  return cleaned
}

/** Describe every sheet with our own vision call, so the plugin works alone. */
async function describeSheets(ctx, settings, sheets, signal) {
  const target = await pickVisionTarget(ctx, settings)
  if (target.error) return { status: 'unavailable', model: null, reason: target.error }

  const llm = ctx.get('llm')
  const label = `${target.provider}/${target.model}`
  const described = []

  for (const sheet of sheets) {
    const ref = SHEET_REFS.get(sheet.path)
    if (!ref) {
      sheet.descriptionError = '该页图片没有进入附件存储，无法识图。'
      continue
    }
    try {
      signal?.throwIfAborted?.()
      sheet.description = await describeSheet(llm, target, ref, sheet, signal)
      described.push(sheet.page)
    } catch (error) {
      sheet.descriptionError = error instanceof Error ? error.message : String(error)
    }
  }

  if (described.length === 0) {
    return {
      status: 'failed',
      model: label,
      reason: sheets[0] && sheets[0].descriptionError ? sheets[0].descriptionError : '识图失败',
    }
  }
  return { status: 'completed', model: label, described: described.length, reason: '' }
}

/* ------------------------------------------------- interval slider bridge */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function intervalState(settings) {
  const effective = RUNTIME_INTERVAL ?? settings.defaultInterval
  return {
    ok: true,
    interval: effective,
    runtime: RUNTIME_INTERVAL,
    configured: settings.defaultInterval,
    min: settings.minInterval,
    max: settings.maxInterval,
  }
}

/**
 * The composer slider talks to this route; the tool reads the same value on its
 * next call, so a human choice survives without model round-tripping.
 */
function installIntervalRoute(ctx, settings) {
  const attach = (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: INTERVAL_ROUTE,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, intervalState(settings))
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req).catch(() => null)
          const raw = body && body.interval
          if (raw === null || raw === undefined || raw === '' || Number(raw) === 0) {
            RUNTIME_INTERVAL = null
            sendJson(res, 200, intervalState(settings))
            return
          }
          const value = Number(raw)
          if (!Number.isFinite(value)) {
            sendJson(res, 400, { ok: false, error: 'interval must be a number' })
            return
          }
          RUNTIME_INTERVAL = clampNumber(
            value,
            settings.minInterval,
            settings.maxInterval,
            settings.defaultInterval,
          )
          sendJson(res, 200, intervalState(settings))
        },
      }),
    )
  }

  // The browser carrier can mount after this plugin. Sampling ctx.get() once
  // would yield undefined and leave the composer slider with no route to call,
  // so prefer the inject channel, which fires when the service is actually up.
  const current = ctx.get('webServer')
  if (current && typeof current.register === 'function') {
    attach(ctx)
    return
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach)
}

/* ------------------------------------------------------------------ tool 1 */

function buildVideoTool(ctx, settings) {
  return {
    name: VIDEO_TOOL_NAME,
    description:
      'Read a video without native video support: sample frames every `interval` seconds into timecoded contact sheets ' +
      '(tiled in playback order, each frame stamped with its timecode), extract the audio track and transcribe it into ' +
      'timestamped speech, then pair every sheet with what was said during that sheet\'s time window. ' +
      'By default the plugin also looks at each sheet itself with an image-capable model and returns a written ' +
      'description, so it works on its own without any vision plugin; set describe=false to skip that and read the ' +
      'sheets with your own vision tools instead. Sheets also enter the conversation as images.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path of the video file (any format ffmpeg can read: mp4, mov, mkv, avi, webm…).',
        },
        interval: {
          type: 'number',
          description:
            'Seconds between sampled frames, 0.1–10. Defaults to 0.5. Out-of-range values are clamped to the nearest bound.',
          minimum: 0.1,
          maximum: 10,
        },
        transcribe: {
          type: 'boolean',
          description:
            'Extract the audio track and transcribe it into timestamped speech. Defaults to true; set false to sample frames only.',
        },
        describe: {
          type: 'boolean',
          description:
            'Describe each sheet with an image-capable model in this Host and return the text. Defaults to true, which ' +
            'makes the tool self-sufficient. Set false when the calling model already sees images itself, or to save tokens.',
        },
        vision_provider: {
          type: 'string',
          description: 'Provider route to use for describe, e.g. "qwen-token-plan-cn". Defaults to the session model, then any image-capable route.',
        },
        vision_model: {
          type: 'string',
          description: 'Model id to use for describe. Only meaningful together with vision_provider.',
        },
        max_sheets: {
          type: 'integer',
          description:
            'Maximum contact sheets to produce, 1–24. Defaults to 4 so the whole video can be viewed in one pass. ' +
            'When the requested interval needs more sheets, the call fails with the interval or max_sheets that would fit.',
          minimum: 1,
          maximum: 24,
        },
        columns: {
          type: 'integer',
          description: 'Sheet columns, 2–8. Defaults to 4.',
          minimum: 2,
          maximum: 8,
        },
        rows: {
          type: 'integer',
          description: 'Sheet rows, 1–8. Defaults to 4.',
          minimum: 1,
          maximum: 8,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          video: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              name: { type: 'string' },
              durationSec: { type: 'number' },
              width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              height: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              fps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              hasVideo: { type: 'boolean' },
              hasAudio: { type: 'boolean' },
            },
          },
          sampling: {
            type: 'object',
            properties: {
              interval: { type: 'number' },
              totalFrames: { type: 'number' },
              columns: { type: 'number' },
              rows: { type: 'number' },
              sheetCount: { type: 'number' },
            },
          },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'number' },
                path: { type: 'string' },
                attachmentId: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                image: { type: 'boolean' },
                description: { type: 'string' },
                descriptionError: { type: 'string' },
              },
            },
          },
          describe: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              reason: { type: 'string' },
            },
          },
          peers: { type: 'array', items: { type: 'string' } },
          transcript: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              recordId: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              sentenceCount: { type: 'number' },
              reason: { type: 'string' },
            },
          },
        },
      },
      render: (args, value) => renderVideoResult(value),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 260000,
    execute: async (args, exec) => runVideoTool(ctx, settings, args, exec),
  }
}

async function runVideoTool(ctx, settings, args, exec) {
  const rawPath = args && args.path ? String(args.path) : ''
  if (!rawPath) throw new Error('path 必填：请提供视频文件的绝对路径。')

  const source = path.resolve(rawPath)
  if (!existsSync(source)) throw new Error(`视频文件不存在：${source}`)
  const info = await stat(source)
  if (!info.isFile()) throw new Error(`目标不是文件：${source}`)

  const interval = clampNumber(
    args.interval ?? RUNTIME_INTERVAL ?? settings.defaultInterval,
    settings.minInterval,
    settings.maxInterval,
    DEFAULTS.defaultInterval,
  )
  const columns = clampInteger(args.columns ?? settings.columns, 2, 8, DEFAULTS.columns)
  const rows = clampInteger(args.rows ?? settings.rows, 1, 8, DEFAULTS.rows)
  const maxSheets = clampInteger(
    args.max_sheets ?? settings.maxSheets,
    1,
    Math.min(24, Number(settings.maxSheetsCap) || DEFAULTS.maxSheetsCap),
    DEFAULTS.maxSheets,
  )
  const wantTranscript = args.transcribe !== false && settings.enableTranscribe !== false
  const wantDescribe = args.describe !== false && settings.enableDescribe !== false
  const signal = exec.signal

  const ffmpeg = resolveFfmpeg(settings)
  const meta = await probeVideo(ffmpeg, source, signal)

  const pageSize = columns * rows
  // A pure audio file has no frames to sample; it still gets transcribed.
  // ffmpeg's fps filter emits round(duration / interval) frames — measured on
  // 8.02s@0.5 (16), 87.33s@10 (9) and 87.33s@9 (10). floor undercounted by one,
  // which made tpad append an extra page of blank cells.
  const totalFrames = meta.hasVideo ? Math.max(1, Math.round(meta.durationSec / interval)) : 0
  const sheetCount = meta.hasVideo ? Math.ceil(totalFrames / pageSize) : 0

  if (meta.hasVideo && sheetCount > maxSheets) {
    const minInterval = Math.ceil((meta.durationSec / (maxSheets * pageSize)) * 10) / 10
    throw new Error(
      `需要 ${sheetCount} 页拼图，超过 max_sheets=${maxSheets}。` +
        `该视频 ${meta.durationSec.toFixed(1)}s，按 ${interval}s 间隔约 ${totalFrames} 帧，` +
        `每页 ${columns}×${rows}=${pageSize} 帧。` +
        `请把 interval 提高到 ≥ ${Math.min(settings.maxInterval, minInterval)}s（覆盖全程），` +
        `或把 max_sheets 提高到 ${Math.min(24, sheetCount)}；` +
        `也可以缩短视频或提高 rows/columns 来增大每页帧数。`,
    )
  }

  let cellWidth = clampInteger(settings.cellWidth, 160, 960, DEFAULTS.cellWidth)
  if (meta.width && meta.height) {
    const ratio = meta.height / meta.width
    const maxCellHeight = Math.floor(2600 / Math.max(1, rows))
    if (cellWidth * ratio > maxCellHeight) {
      cellWidth = Math.max(160, Math.floor(maxCellHeight / ratio))
    }
  }

  const plan = {
    interval,
    columns,
    rows,
    cellWidth,
    quality: clampInteger(settings.jpegQuality, 2, 20, DEFAULTS.jpegQuality),
    totalFrames,
  }

  let sheetPaths = []
  let workDir = null
  let lastError = null
  const deniedRoots = []

  for (const root of artifactCandidates(settings)) {
    const candidateDir = path.join(root, `${slugify(path.basename(source))}-${Date.now().toString(36)}`)
    try {
      await mkdir(candidateDir, { recursive: true })
      if (meta.hasVideo) {
        sheetPaths = await extractSheets(settings, ffmpeg, source, meta, plan, candidateDir, signal)
      }
      workDir = candidateDir
      await pruneArtifacts(root, Number(settings.keepArtifactDirs) || DEFAULTS.keepArtifactDirs)
      break
    } catch (error) {
      lastError = error
      deniedRoots.push(root)
      sheetPaths = []
      await rm(candidateDir, { recursive: true, force: true }).catch(() => {})
      if (signal?.aborted) throw error
    }
  }

  if (!workDir || (meta.hasVideo && sheetPaths.length === 0)) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      `写入产物失败，已尝试的目录：${deniedRoots.join(' ; ')}。` +
        `可在插件配置里把 artifactDir 指向一个可写目录。底层错误：${detail}`,
    )
  }

  const attachments = ctx.get('attachments')
  const sheets = []
  for (let index = 0; index < sheetPaths.length; index += 1) {
    const sheetPath = sheetPaths[index]
    const fromSec = index * pageSize * interval
    const toSec = Math.min(meta.durationSec, (index + 1) * pageSize * interval)
    const entry = {
      page: index + 1,
      path: sheetPath,
      from: formatTimestamp(fromSec),
      fromSec,
      to: formatTimestamp(toSec),
      toSec,
      attachmentId: '',
      image: false,
    }

    if (attachments) {
      try {
        const bytes = await readFile(sheetPath)
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType: 'image/jpeg',
          name: `${slugify(path.basename(source))}-p${index + 1}.jpg`,
        })
        entry.attachmentId = ref.attachmentId
        entry.image = true
        SHEET_REFS.set(sheetPath, ref)
      } catch (error) {
        entry.imageError = error instanceof Error ? error.message : String(error)
      }
    }

    sheets.push(entry)
  }

  const visionSettings = {
    ...settings,
    visionProvider: args.vision_provider || settings.visionProvider,
    visionModel: args.vision_model || settings.visionModel,
  }

  // Vision and speech are independent pipelines: describing reads the sheets we
  // already committed, transcription re-reads the audio track. Race them so a slow
  // transcript never delays the description and vice versa.
  const describePromise = wantDescribe
    ? describeSheets(ctx, visionSettings, sheets, signal).catch((error) => ({
        status: 'failed',
        model: null,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : Promise.resolve({ status: 'disabled', model: null, reason: '' })

  const transcriptPromise = (async () => {
    if (!wantTranscript) {
      return { status: 'disabled', recordId: null, segments: [], text: '', summary: '' }
    }
    if (!meta.hasAudio) {
      return {
        status: 'no-audio',
        recordId: null,
        segments: [],
        text: '',
        summary: '',
        reason: '该视频没有音轨。',
      }
    }
    try {
      const audioPath = await extractAudio(settings, ffmpeg, source, workDir, signal)
      const transcription = await runTranscription(settings, audioPath, meta.durationSec, signal)
      return { ...transcription, audioPath }
    } catch (error) {
      return {
        status: 'failed',
        recordId: null,
        segments: [],
        text: '',
        summary: '',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })()

  const [describeResult, transcript] = await Promise.all([describePromise, transcriptPromise])

  const segments = Array.isArray(transcript.segments) ? transcript.segments : []
  for (const sheet of sheets) {
    sheet.lines = linesInWindow(segments, sheet.fromSec, sheet.toSec).map((line) => ({
      t: line.startSec === null ? '' : formatTimestamp(line.startSec),
      s: line.speaker || '',
      x: line.text,
    }))
  }

  const fullText = String(transcript.text || '')
  const truncatedText =
    fullText.length > Number(settings.maxTranscriptChars || DEFAULTS.maxTranscriptChars)
      ? `${fullText.slice(0, Number(settings.maxTranscriptChars || DEFAULTS.maxTranscriptChars))}…`
      : fullText

  return {
    video: {
      path: source,
      name: path.basename(source),
      durationSec: Number(meta.durationSec.toFixed(2)),
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasVideo: meta.hasVideo,
      hasAudio: meta.hasAudio,
      bytes: info.size,
    },
    sampling: {
      interval,
      totalFrames,
      columns,
      rows,
      pageSize,
      sheetCount: sheets.length,
      cellWidth,
      artifactDir: workDir,
    },
    sheets: sheets.map((sheet) => ({
      page: sheet.page,
      path: sheet.path,
      attachmentId: sheet.attachmentId,
      from: sheet.from,
      to: sheet.to,
      image: sheet.image,
      lines: sheet.lines,
      ...(sheet.description ? { description: sheet.description } : {}),
      ...(sheet.descriptionError ? { descriptionError: sheet.descriptionError } : {}),
      ...(sheet.imageError ? { imageError: sheet.imageError } : {}),
    })),
    describe: {
      status: describeResult.status,
      model: describeResult.model ?? null,
      ...(describeResult.reason ? { reason: describeResult.reason } : {}),
    },
    transcript: {
      status: transcript.status,
      recordId: transcript.recordId ?? null,
      sentenceCount: segments.length,
      text: truncatedText,
      truncated: fullText.length > truncatedText.length,
      summary: String(transcript.summary || '').slice(0, 4000),
      ...(transcript.reason ? { reason: transcript.reason } : {}),
    },
    peers: detectVisionPeers(ctx),
  }
}

function renderVideoResult(value) {
  const blocks = []
  const video = value.video || {}
  const sampling = value.sampling || {}
  const transcript = value.transcript || {}
  const sheets = Array.isArray(value.sheets) ? value.sheets : []

  const header = []
  const isAudioOnly = video.hasVideo === false
  if (isAudioOnly) {
    header.push(`🎵 ${video.name} · ${formatDuration(video.durationSec)} · 纯音频（无画面可抽帧）`)
  } else {
    header.push(
      `🎬 ${video.name} · ${formatDuration(video.durationSec)} · ` +
        `${video.width || '?'}×${video.height || '?'}` +
        (video.fps ? ` · ${video.fps}fps` : '') +
        (video.hasAudio ? ' · 含音轨' : ' · 无音轨'),
    )
    header.push(
      `📐 每 ${sampling.interval}s 一帧 · 共 ${sampling.totalFrames} 帧 · ` +
        `${sampling.columns}×${sampling.rows}/页 · ${sampling.sheetCount} 页`,
    )
  }

  const describe = value.describe || {}
  const peers = Array.isArray(value.peers) ? value.peers : []

  if (describe.status === 'completed') {
    header.push(`👁 画面已逐页描述（${describe.model}）`)
  } else if (describe.status === 'disabled') {
    if (!isAudioOnly) header.push('👁 已按参数跳过画面描述：请自行查看下面每页的图片')
  } else if (describe.status === 'unavailable' || describe.status === 'failed') {
    header.push(`👁 画面未描述：${describe.reason || '未知原因'}（图片仍在下方，可自行查看）`)
  }

  if (transcript.status === 'completed') {
    header.push(`🗣 台词已转写 ${transcript.sentenceCount} 句（记录 ${transcript.recordId}）`)
  } else if (transcript.status === 'processing') {
    header.push(`🗣 台词转写中（记录 ${transcript.recordId || '?'}）：稍后用 ${TRANSCRIPT_TOOL_NAME} 取回`)
  } else if (transcript.status === 'empty') {
    header.push('🗣 未识别到语音内容')
  } else if (transcript.status === 'unavailable' || transcript.status === 'failed') {
    header.push(`🗣 台词不可用：${transcript.reason || '未知原因'}`)
  } else if (transcript.status === 'no-audio') {
    header.push('🗣 该视频没有音轨')
  } else if (transcript.status === 'disabled') {
    header.push('🗣 已按参数跳过音频转写')
  }

  if (peers.length > 0) {
    header.push(
      `ℹ 检测到同场插件：${peers.join('、')}。本插件工具名为 read_video*，不占用 vision_ 前缀，` +
        '与 vision-router 的视觉模式互不干涉；两者同时启用只会各花各的视觉调用。',
    )
  }

  const noAudio = transcript.status === 'no-audio'
  header.push('')
  if (isAudioOnly) {
    header.push('该文件没有视频流，本次只做语音转写。')
  } else {
    header.push(
      noAudio
        ? '每页下方是该页的画面描述。'
        : '每页下方是该页的画面描述与时间段内说出的台词，可直接逐格对照。',
    )
  }
  blocks.push({ type: 'text', text: header.join('\n') })

  for (const sheet of sheets) {
    const ref = SHEET_REFS.get(sheet.path)
    if (ref) {
      blocks.push({ type: 'image', attachment: ref })
    }

    const lines = Array.isArray(sheet.lines) ? sheet.lines : []
    const parts = [
      `── 第 ${sheet.page}/${sheets.length} 页 · ${sheet.from} – ${sheet.to}` +
        (sheet.attachmentId ? ` · 附件 ${sheet.attachmentId}` : ''),
    ]
    if (!ref) parts.push(`（图片未能进入会话，可直接打开：${sheet.path}）`)

    if (sheet.description) {
      parts.push('', '【画面】', sheet.description)
    } else if (sheet.descriptionError) {
      parts.push('', `【画面】未能描述：${sheet.descriptionError}`)
    }

    if (noAudio) {
      // No audio track at all: repeating "no dialogue here" on every page is noise.
    } else if (lines.length === 0) {
      parts.push('', '【台词】（该时段无台词）')
    } else {
      parts.push(
        '',
        '【台词】',
        lines.map((line) => `${line.t} ${line.s ? `${line.s}：` : ''}${line.x}`).join('\n'),
      )
    }
    blocks.push({ type: 'text', text: parts.join('\n') })
  }

  const footer = []
  if (transcript.text) {
    footer.push('', '===== 全文台词 =====', transcript.text)
    if (transcript.truncated) {
      footer.push(`（全文共 ${transcript.text.length} 字符，已截断；用 ${TRANSCRIPT_TOOL_NAME} 取完整版）`)
    }
  }
  if (transcript.recordId) {
    footer.push(`完整原文与纪要：${TRANSCRIPT_TOOL_NAME}(record_id=${transcript.recordId})`)
  }
  if (sheets.length > 0) {
    footer.push(`拼图文件目录：${sampling.artifactDir}`)
  }
  if (footer.length) blocks.push({ type: 'text', text: footer.join('\n') })

  return blocks
}

/* ------------------------------------------------------------------ tool 2 */

function buildTranscriptTool(ctx, settings) {
  return {
    name: TRANSCRIPT_TOOL_NAME,
    description:
      'Fetch the full timestamped speech transcript of a previously sampled video by its record id ' +
      '(read_video reports it), including the automatic meeting summary when available. ' +
      'Use it when the video tool reported status "processing", or when its transcript was truncated.',
    parameters: {
      type: 'object',
      properties: {
        record_id: {
          type: 'integer',
          description: 'The transcript record id reported by vision_video.',
        },
        wait_seconds: {
          type: 'integer',
          description:
            'How long to keep polling while the transcript is still being produced, 0–180 seconds. Defaults to 30.',
          minimum: 0,
          maximum: 180,
        },
      },
      required: ['record_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          recordId: { type: 'number' },
          status: { type: 'string' },
          sentenceCount: { type: 'number' },
          text: { type: 'string' },
          summary: { type: 'string' },
          durationSec: { type: 'number' },
        },
      },
      render: (args, value) => {
        const lines = [
          `📄 记录 ${value.recordId} · 状态 ${value.status} · ${value.sentenceCount} 句` +
            (value.durationSec ? ` · ${formatDuration(value.durationSec)}` : ''),
        ]
        if (value.reason) lines.push(`说明：${value.reason}`)
        if (value.text) lines.push('', value.text)
        if (value.summary) lines.push('', '===== 自动纪要 =====', value.summary)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 200000,
    execute: async (args, exec) => {
      const recordId = Number(args && args.record_id)
      if (!Number.isFinite(recordId) || recordId <= 0) {
        throw new Error('record_id 必填：请传入 vision_video 报出的转写记录 id。')
      }
      const settingsKey = resolveItingnaoKey(settings)
      if (!settingsKey) {
        throw new Error(
          '未配置 ITINGNAO_API_KEY：可在插件配置里设置 itingnaoApiKey，或把该变量加入用户环境变量后重启 DSH。',
        )
      }

      const waitMs = clampInteger(args.wait_seconds ?? 30, 0, 180, 30) * 1000
      const deadline = Date.now() + waitMs
      let detail = await fetchRecordDetail(settings, settingsKey, recordId, exec.signal)
      let triggered = false

      while (Date.now() < deadline) {
        const status = Number(detail.status)
        const dataStatus = Number(detail.data_status)
        if (status === 90 && !triggered) {
          await triggerManualTranscribe(settings, settingsKey, recordId, exec.signal)
          triggered = true
        } else if (dataStatus === 1 || status === 4 || status === 100 || status === -2) {
          break
        }
        await delay(2500, exec.signal)
        detail = await fetchRecordDetail(settings, settingsKey, recordId, exec.signal)
      }

      const durationMs = Number(detail.file_duration)
      const durationSec = Number.isFinite(durationMs) ? durationMs / 1000 : 0
      const segments = normalizeSegments(detail.data, durationSec)
      const status = Number(detail.status)
      const dataStatus = Number(detail.data_status)
      const done = dataStatus === 1 || status === 4
      const summary = typeof detail.meeting_summary === 'string' ? detail.meeting_summary.trim() : ''

      return {
        recordId,
        status: done ? (segments.length ? 'completed' : 'empty') : 'processing',
        sentenceCount: segments.length,
        durationSec: Number(durationSec.toFixed(2)),
        text: segments.length ? joinSegmentText(segments) : '',
        summary,
        ...(done
          ? segments.length
            ? {}
            : { reason: '听脑未识别出语音内容（可能是纯音乐、静音或无人声）。' }
          : { reason: '转写仍在进行，请稍后再次查询。' }),
      }
    },
  }
}

/* -------------------------------------------------------------- activation */

export const inject = ['tools']

export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  ctx.effect(() => ctx.tools.register(buildVideoTool(ctx, settings)))
  ctx.effect(() => ctx.tools.register(buildTranscriptTool(ctx, settings)))
  installIntervalRoute(ctx, settings)
}
