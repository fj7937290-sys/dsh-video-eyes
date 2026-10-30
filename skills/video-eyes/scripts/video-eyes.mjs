#!/usr/bin/env node
/**
 * video-eyes — let a text-only agent read a video.
 *
 * Two capabilities on one timeline:
 *   1. frames  : sample the video every N seconds, stamp each frame with its
 *                timecode, and tile them into contact sheets in playback order.
 *   2. audio   : extract the audio track and (optionally) transcribe it into
 *                timestamped sentences, then pair every sheet with what was
 *                said during that sheet's time window.
 *
 * Everything is plain Node (>=18) plus any ffmpeg binary; nothing else to install.
 *
 *   node video-eyes.mjs run <video> [--interval 0.5] [--no-audio]
 *   node video-eyes.mjs frames <video> [--interval 0.5] [--cols 4] [--rows 4]
 *   node video-eyes.mjs audio <video>
 *   node video-eyes.mjs transcribe <audio|video> [--wait 90]
 *   node video-eyes.mjs transcript <record-id>
 *
 * Output is JSON on stdout so any agent can parse it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ITINGNAO_BASE = process.env.ITINGNAO_BASE_URL || 'https://api.itingnao.com'
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

/* ------------------------------------------------------------------ utils */

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return `${pad2(minutes)}:${rest.toFixed(1).padStart(4, '0')}`
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(rest)}`
  return `${pad2(minutes)}:${pad2(rest)}`
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function slugify(value) {
  return (
    String(value || 'video')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'video'
  )
}

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return { positional, options }
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

function fpsExpression(interval) {
  const denominator = Math.round(interval * 1000)
  const numerator = 1000
  const divisor = gcd(numerator, denominator)
  return `${numerator / divisor}/${denominator / divisor}`
}

function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:')
}

/* ----------------------------------------------------------------- ffmpeg */

function resolveFfmpeg(explicit) {
  const tried = []
  const candidates = []
  if (explicit) candidates.push(String(explicit))
  if (process.env.VIDEO_EYES_FFMPEG) candidates.push(process.env.VIDEO_EYES_FFMPEG)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  candidates.push('ffmpeg')
  // A bundled copy shipped next to this script, then a couple of common spots.
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'bin', 'ffmpeg.exe'))
  candidates.push(path.join(process.cwd(), '_tools', 'pylibs', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win64-v4.2.2.exe'))

  for (const candidate of candidates) {
    if (!candidate) continue
    tried.push(candidate)
    if (candidate === 'ffmpeg') {
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 15000 })
        return 'ffmpeg'
      } catch {
        continue
      }
    }
    if (!existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 15000 })
      return candidate
    } catch {
      // next
    }
  }

  throw new Error(
    `No usable ffmpeg found. Tried: ${tried.join(' ; ')}. ` +
      'Install ffmpeg (or set VIDEO_EYES_FFMPEG / --ffmpeg to its path).',
  )
}

function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill('SIGKILL')
          } catch {
            // gone
          }
          reject(new Error(`${path.basename(bin)} timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : null

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function probeVideo(ffmpeg, source) {
  const { stderr } = await runProcess(ffmpeg, ['-hide_banner', '-i', source], { timeoutMs: 60000 })
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSec = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  const sizeMatch = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  const fpsMatch = /Video:.*?(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  const hasVideo = /Stream #\d+:\d+.*?Video:/.test(stderr)
  const hasAudio = /Stream #\d+:\d+.*?Audio:/.test(stderr)

  if (!hasVideo) throw new Error(`No video stream found in ${source}`)
  if (!(durationSec > 0)) throw new Error(`Could not read the duration of ${source}`)

  return {
    durationSec,
    width: sizeMatch ? Number(sizeMatch[1]) : null,
    height: sizeMatch ? Number(sizeMatch[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    hasAudio,
  }
}

function pickFont() {
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function extractSheets(ffmpeg, source, meta, plan, workDir) {
  const { interval, columns, rows, cellWidth, quality, totalFrames } = plan
  const pageSize = columns * rows
  const remainder = totalFrames % pageSize
  const padFrames = remainder === 0 ? 0 : pageSize - remainder
  const pattern = path.join(workDir, 'sheet-%02d.jpg')

  const font = pickFont()
  const fontSize = Math.max(14, Math.round(cellWidth / 20))
  const parts = [`fps=${fpsExpression(interval)}`, `scale=${cellWidth}:-2:flags=lanczos`]
  if (font) {
    parts.push(
      [
        `drawtext=fontfile='${escapeFilterPath(font)}'`,
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

  const result = await runProcess(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-vf', parts.join(','),
      '-vsync', '0',
      '-q:v', String(quality),
      '-f', 'image2',
      pattern,
    ],
    { timeoutMs: 600000 },
  )

  if (result.code !== 0) {
    throw new Error(`ffmpeg frame extraction failed (exit ${result.code}): ${result.stderr.trim().slice(0, 800)}`)
  }

  const names = (await readdir(workDir)).filter((name) => /^sheet-\d+\.jpg$/.test(name)).sort()
  if (names.length === 0) throw new Error('ffmpeg produced no contact sheets')
  return names.map((name) => path.join(workDir, name))
}

async function extractAudio(ffmpeg, source, workDir) {
  const target = path.join(workDir, 'audio.mp3')
  const result = await runProcess(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', target],
    { timeoutMs: 600000 },
  )
  if (result.code !== 0 || !existsSync(target)) {
    throw new Error(`ffmpeg audio extraction failed: ${result.stderr.trim().slice(0, 500)}`)
  }
  return target
}

/* --------------------------------------------------------------- itingnao */

function readWindowsUserEnvironment(name) {
  if (process.platform !== 'win32') return undefined
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i').exec(output || '')
    return match ? match[1].trim() : undefined
  } catch {
    return undefined
  }
}

function resolveApiKey(explicit) {
  if (explicit) return String(explicit)
  if (process.env.ITINGNAO_API_KEY) return process.env.ITINGNAO_API_KEY
  return readWindowsUserEnvironment('ITINGNAO_API_KEY')
}

async function apiRequest(key, { method, apiPath, query, body, teamId }) {
  const url = new URL(ITINGNAO_BASE.replace(/\/+$/, '') + apiPath)
  if (query) {
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(name, String(value))
    }
  }
  const headers = { Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${key}` }
  const init = { method, headers }
  let payload = body
  if (teamId) {
    if (method === 'GET') url.searchParams.set('team_id', String(teamId))
    else if (payload && typeof payload === 'object') payload = { team_id: teamId, ...payload }
  }
  if (payload !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json;charset=UTF-8'
    init.body = JSON.stringify(payload)
  }
  const response = await fetch(url, init)
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`iTingnao returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`iTingnao request failed HTTP ${response.status}: ${text.slice(0, 300)}`)
  return data
}

async function uploadAudio(key, audioPath, teamId) {
  const signResponse = await apiRequest(key, { method: 'GET', apiPath: '/api/common/sign', query: { oss_dir: '' }, teamId })
  if (Number(signResponse.code) !== 200 || !signResponse.data) {
    throw new Error(`failed to get an upload signature: ${JSON.stringify(signResponse).slice(0, 300)}`)
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

  const upload = await fetch(sign.host, { method: 'POST', body: form })
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '')
    throw new Error(`iTingnao OSS upload failed HTTP ${upload.status}: ${detail.slice(0, 300)}`)
  }
  return { objectKey, fileName }
}

async function createTask(key, objectKey, fileName, durationSec, teamId) {
  const response = await apiRequest(key, {
    method: 'POST',
    apiPath: '/api/record/create',
    teamId,
    body: {
      trans_type: 1,
      chat_num: 1,
      style: 2,
      file_source_type: 1,
      name: fileName,
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
  const recordId = Array.isArray(response.data) ? response.data[0] && response.data[0].id : response.data && response.data.id
  if (!recordId) throw new Error(`failed to create the transcript task: ${JSON.stringify(response).slice(0, 300)}`)
  return Number(recordId)
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
    const text = String(entry.text ?? entry.content ?? entry.sentence ?? entry.words ?? '').trim()
    if (!text) continue
    const begin = firstNumber(entry.beginTime, entry.begin_time, entry.startTime, entry.start_time, entry.start)
    const end = firstNumber(entry.endTime, entry.end_time, entry.end)
    const speaker = String(entry.userName ?? entry.speaker ?? '').trim()
    segments.push({ text, startSec: begin, endSec: end, speaker })
  }

  const starts = segments.map((segment) => segment.startSec).filter((value) => value !== null)
  if (starts.length > 0) {
    const maxStart = Math.max(...starts)
    // iTingnao reports milliseconds; some payloads carry seconds instead.
    const divisor = durationSec > 0 && maxStart <= durationSec * 1.5 + 5 ? 1 : 1000
    for (const segment of segments) {
      if (segment.startSec !== null) segment.startSec = segment.startSec / divisor
      if (segment.endSec !== null) segment.endSec = segment.endSec / divisor
    }
  }
  return segments
}

async function transcriptByRecordId(key, recordId, waitSeconds, teamId) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  let triggered = false
  let detail = await apiRequest(key, { method: 'GET', apiPath: '/api/record/detail', query: { id: recordId, summary_new: '1' }, teamId })

  while (Date.now() < deadline) {
    const status = Number(detail.status)
    const dataStatus = Number(detail.data_status)
    if (dataStatus === 1 || status === 4 || status === 100 || status === -2) break
    if (status === 90 && !triggered) {
      await apiRequest(key, { method: 'POST', apiPath: '/api/record/reset_handle', teamId, body: { id: recordId, privilege_type: 1 } })
      triggered = true
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
    detail = await apiRequest(key, { method: 'GET', apiPath: '/api/record/detail', query: { id: recordId, summary_new: '1' }, teamId })
  }

  const durationMs = Number(detail.file_duration)
  const durationSec = Number.isFinite(durationMs) ? durationMs / 1000 : 0
  const segments = normalizeSegments(detail.data, durationSec)
  const status = Number(detail.status)
  const dataStatus = Number(detail.data_status)
  const done = dataStatus === 1 || status === 4

  return {
    recordId,
    status: done ? (segments.length ? 'completed' : 'empty') : 'processing',
    sentenceCount: segments.length,
    durationSec: Number(durationSec.toFixed(2)),
    segments,
    text: segments.map((segment) => segment.text).join(''),
    summary: typeof detail.meeting_summary === 'string' ? detail.meeting_summary.trim() : '',
  }
}

/* ------------------------------------------------------------------- main */

function segmentsInWindow(segments, fromSec, toSec) {
  return segments.filter(
    (segment) => segment.startSec !== null && segment.startSec >= fromSec - 0.25 && segment.startSec < toSec,
  )
}

/* ---------------------------------------------------------------- describe */

/**
 * Optional self-contained image understanding: any OpenAI-compatible
 * `/chat/completions` endpoint that accepts image_url content parts.
 * Configured through env vars or flags; absent configuration means the caller
 * does the looking with whatever vision tool it has.
 */
function visionConfig(options) {
  const baseUrl = options['vision-base-url'] || process.env.VIDEO_EYES_VISION_BASE_URL
  const apiKey = options['vision-api-key'] || process.env.VIDEO_EYES_VISION_API_KEY
  const model = options['vision-model'] || process.env.VIDEO_EYES_VISION_MODEL
  if (!baseUrl || !model) return null
  return { baseUrl: String(baseUrl), apiKey: apiKey ? String(apiKey) : '', model: String(model) }
}

async function describeSheet(vision, sheetPath, sheet) {
  const bytes = await readFile(sheetPath)
  const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`
  const prompt = [
    `这是一张视频抽帧拼图（第 ${sheet.page} 页），按从左到右、从上到下是播放顺序，`,
    '每格左上角的黄色文字是该帧在视频里的真实时间码。',
    `本页覆盖 ${sheet.from} – ${sheet.to}。`,
    '请逐格描述：每格是什么（人物 / 界面 / 幻灯片 / 图表 / 字幕 / 场景），',
    '并指出明显的变化点（场景切换、换页、关键信息出现）。',
    '直接给结论，不要客套。如果某格是纯黑或空白，说明它多半是视频尾部补位，不用解读。',
  ].join('')

  const response = await fetch(`${vision.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(vision.apiKey ? { Authorization: `Bearer ${vision.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: vision.model,
      max_tokens: 900,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`vision endpoint HTTP ${response.status}: ${detail.slice(0, 300)}`)
  }
  const payload = await response.json()
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message
  const content = message && message.content
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('')
    : String(content || '')
  return text.trim()
}

function printHelp() {
  console.log(`video-eyes — read a video with a text-only model

Usage:
  node video-eyes.mjs run <video> [options]        frames + audio + transcript in one pass
  node video-eyes.mjs frames <video> [options]     contact sheets only
  node video-eyes.mjs audio <video> [options]      extract the audio track only
  node video-eyes.mjs transcribe <audio|video> [options]
  node video-eyes.mjs transcript <record-id> [options]

Options:
  --interval <sec>    seconds between sampled frames, 0.1-10 (default 0.5)
  --cols <n>          sheet columns, 2-8 (default 4)
  --rows <n>          sheet rows, 1-8 (default 4)
  --max-sheets <n>    refuse to produce more sheets than this (default 4)
  --width <px>        per-frame width inside a sheet (default 480)
  --out <dir>         artifact directory (default <cwd>/.video-eyes)
  --no-audio          skip audio extraction and transcription
  --describe          describe each sheet with a vision model (needs the vision flags/env)
  --no-describe       never describe sheets
  --vision-base-url   OpenAI-compatible base URL, e.g. https://api.example.com/v1
  --vision-api-key    bearer token for that endpoint
  --vision-model      model id that accepts image input
  --wait <sec>        keep polling the transcript this long (default 90)
  --record-id <id>    reuse an existing iTingnao record
  --api-key <key>     iTingnao API key (default $ITINGNAO_API_KEY)
  --team-id <id>      iTingnao team space
  --ffmpeg <path>     ffmpeg binary (default $VIDEO_EYES_FFMPEG, then PATH)
  --json              print machine-readable JSON to stdout (default)
`)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (!command || command === 'help' || options.help) {
    printHelp()
    return
  }

  const ffmpeg = resolveFfmpeg(options.ffmpeg)
  const outRoot = options.out ? path.resolve(String(options.out)) : path.join(process.cwd(), '.video-eyes')

  const emit = (payload) => {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  }

  if (command === 'transcript') {
    const key = resolveApiKey(options['api-key'])
    if (!key) throw new Error('No iTingnao API key: pass --api-key or set ITINGNAO_API_KEY.')
    const recordId = Number(positional[1] || options['record-id'])
    if (!Number.isFinite(recordId) || recordId <= 0) throw new Error('transcript requires a numeric <record-id>')
    const result = await transcriptByRecordId(key, recordId, clamp(options.wait, 0, 600, 60), options['team-id'])
    emit({ command, ...result })
    return
  }

  const source = positional[1] || options.input
  if (!source) throw new Error(`${command} requires a <video> path`)
  const absolute = path.resolve(String(source))
  if (!existsSync(absolute)) throw new Error(`file not found: ${absolute}`)

  if (command === 'transcribe') {
    const key = resolveApiKey(options['api-key'])
    if (!key) throw new Error('No iTingnao API key: pass --api-key or set ITINGNAO_API_KEY.')
    const meta = await probeVideo(ffmpeg, absolute).catch(() => ({ durationSec: 0 }))
    const workDir = path.join(outRoot, `${slugify(path.basename(absolute))}-${Date.now().toString(36)}`)
    await mkdir(workDir, { recursive: true })
    const audioPath = await extractAudio(ffmpeg, absolute, workDir)
    const { objectKey, fileName } = await uploadAudio(key, audioPath, options['team-id'])
    const recordId = await createTask(key, objectKey, fileName, meta.durationSec, options['team-id'])
    const result = await transcriptByRecordId(key, recordId, clamp(options.wait, 0, 600, 90), options['team-id'])
    emit({ command, source: absolute, audioPath, ...result })
    return
  }

  if (command === 'audio') {
    const workDir = path.join(outRoot, `${slugify(path.basename(absolute))}-${Date.now().toString(36)}`)
    await mkdir(workDir, { recursive: true })
    const audioPath = await extractAudio(ffmpeg, absolute, workDir)
    emit({ command, source: absolute, audioPath, bytes: statSync(audioPath).size })
    return
  }

  if (command !== 'frames' && command !== 'run') {
    throw new Error(`unknown command: ${command} (try "help")`)
  }

  const interval = clamp(options.interval, 0.1, 10, 0.5)
  const columns = Math.trunc(clamp(options.cols, 2, 8, 4))
  const rows = Math.trunc(clamp(options.rows, 1, 8, 4))
  const maxSheets = Math.trunc(clamp(options['max-sheets'], 1, 24, 4))

  const meta = await probeVideo(ffmpeg, absolute)
  const pageSize = columns * rows
  const totalFrames = Math.max(1, Math.floor(meta.durationSec / interval))
  const sheetCount = Math.ceil(totalFrames / pageSize)

  if (sheetCount > maxSheets) {
    const suggested = Math.ceil((meta.durationSec / (maxSheets * pageSize)) * 10) / 10
    throw new Error(
      `would need ${sheetCount} sheets but --max-sheets is ${maxSheets}. ` +
        `This video is ${meta.durationSec.toFixed(1)}s at ${interval}s = ~${totalFrames} frames, ` +
        `${columns}x${rows} = ${pageSize} frames per sheet. ` +
        `Raise --interval to >= ${Math.min(10, suggested)}s, or raise --max-sheets to ${Math.min(24, sheetCount)}.`,
    )
  }

  let cellWidth = Math.trunc(clamp(options.width, 160, 960, 480))
  if (meta.width && meta.height) {
    const ratio = meta.height / meta.width
    const maxCellHeight = Math.floor(2600 / Math.max(1, rows))
    if (cellWidth * ratio > maxCellHeight) cellWidth = Math.max(160, Math.floor(maxCellHeight / ratio))
  }

  const workDir = path.join(outRoot, `${slugify(path.basename(absolute))}-${Date.now().toString(36)}`)
  await mkdir(workDir, { recursive: true })

  const plan = { interval, columns, rows, cellWidth, quality: 3, totalFrames }
  const sheetPaths = await extractSheets(ffmpeg, absolute, meta, plan, workDir)

  const sheets = sheetPaths.map((sheetPath, index) => ({
    page: index + 1,
    path: sheetPath,
    fromSec: index * pageSize * interval,
    toSec: Math.min(meta.durationSec, (index + 1) * pageSize * interval),
  }))
  for (const sheet of sheets) {
    sheet.from = formatTimestamp(sheet.fromSec)
    sheet.to = formatTimestamp(sheet.toSec)
  }

  let transcript = { status: 'skipped', recordId: null, segments: [], text: '', summary: '', sentenceCount: 0 }

  if (command === 'run' && !options['no-audio'] && meta.hasAudio) {
    try {
      const key = resolveApiKey(options['api-key'])
      if (!key) {
        transcript = {
          status: 'unavailable',
          recordId: null,
          segments: [],
          text: '',
          summary: '',
          sentenceCount: 0,
          reason: 'No iTingnao API key: pass --api-key or set ITINGNAO_API_KEY. Frames were still produced.',
        }
      } else {
        const audioPath = await extractAudio(ffmpeg, absolute, workDir)
        const { objectKey, fileName } = await uploadAudio(key, audioPath, options['team-id'])
        const recordId = await createTask(key, objectKey, fileName, meta.durationSec, options['team-id'])
        transcript = await transcriptByRecordId(key, recordId, clamp(options.wait, 0, 600, 90), options['team-id'])
        transcript.audioPath = audioPath
      }
    } catch (error) {
      transcript = {
        status: 'failed',
        recordId: null,
        segments: [],
        text: '',
        summary: '',
        sentenceCount: 0,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  } else if (command === 'run' && !meta.hasAudio) {
    transcript.status = 'no-audio'
    transcript.reason = 'this video has no audio track'
  }

  // Optional self-contained image understanding, independent of any vision plugin.
  let describe = { status: 'disabled', model: null, reason: '' }
  const vision = visionConfig(options)
  const wantDescribe = options['no-describe'] ? false : Boolean(vision)
  if (wantDescribe) {
    describe = { status: 'pending', model: vision.model, reason: '' }
    let ok = 0
    for (const sheet of sheets) {
      try {
        sheet.description = await describeSheet(vision, sheet.path, sheet)
        ok += 1
      } catch (error) {
        sheet.descriptionError = error instanceof Error ? error.message : String(error)
      }
    }
    describe.status = ok > 0 ? 'completed' : 'failed'
    if (ok === 0 && sheets[0] && sheets[0].descriptionError) describe.reason = sheets[0].descriptionError
  } else if (!options['no-describe'] && !vision) {
    describe = {
      status: 'unavailable',
      model: null,
      reason:
        '未配置视觉端点：设置 VIDEO_EYES_VISION_BASE_URL / VIDEO_EYES_VISION_MODEL（可选 _API_KEY），' +
        '或用你自己的视觉工具直接看 sheets[].path。',
    }
  }

  const segments = Array.isArray(transcript.segments) ? transcript.segments : []
  for (const sheet of sheets) {
    sheet.lines = segmentsInWindow(segments, sheet.fromSec, sheet.toSec).map((line) => ({
      t: line.startSec === null ? '' : formatTimestamp(line.startSec),
      s: line.speaker || '',
      x: line.text,
    }))
  }

  emit({
    command,
    video: {
      path: absolute,
      name: path.basename(absolute),
      durationSec: Number(meta.durationSec.toFixed(2)),
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      bytes: statSync(absolute).size,
    },
    sampling: { interval, totalFrames, columns, rows, pageSize, sheetCount: sheets.length, cellWidth, artifactDir: workDir },
    describe,
    sheets,
    transcript: {
      status: transcript.status,
      recordId: transcript.recordId ?? null,
      sentenceCount: segments.length,
      text: transcript.text || '',
      summary: transcript.summary || '',
      ...(transcript.reason ? { reason: transcript.reason } : {}),
    },
  })
}

main().catch((error) => {
  process.stderr.write(`video-eyes: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
