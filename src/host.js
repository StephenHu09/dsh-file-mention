/**
 * dsh-file-mention —— Host 半体
 *
 * 通过 `webServer` 注册 `/file-mention/list` HTTP 路由：
 *   - 解析会话工作区（ctx.sessions）
 *   - 通过 git ls-files 列出跟踪文件（天然遵守 .gitignore，排除编译产物与未跟踪文件）
 *   - 读取工作区根目录 .aiinclude，把被忽略但 AI 需要的文件重新纳入
 *   - git 不可用/非仓库时回退为 .gitignore 解析 + 全量扫描
 *
 * 构建时由 scripts/build.mjs 将 src/core.js 内联进来，产物无任何外部依赖。
 */
import {
  compileRules, matchRules, lastMatchRule, dirMayLeadToMatch, parseStatusZ, flattenNestedRules,
} from './core.js'

const name = 'dsh-file-mention'
const inject = ['sessions', 'webServer']

/** 请求体大小上限（防御超大请求）。 */
const BODY_CAP_BYTES = 64 * 1024

/** 遍历时跳过的重型目录（.aiinclude 命中可覆盖）。 */
const SKIP = new Set([
  '.git', 'node_modules', '.gradle', '.idea', '.kotlin', '.cxx',
  '.externalNativeBuild', 'build', 'out', 'target', 'dist', 'release',
  'debug', '.dsh', '.agents', '.claude', '.codex', 'storages', 'sessions',
])
/** 文件总数上限（防超大仓库：列表体积、传输、客户端每次按键排序成本）。 */
const CAP = 10000
/** 遍历深度上限（真实项目普遍 ≤20 层，32 留足余量）。 */
const MAX_DEPTH = 32

/** git 结果缓存 TTL：仓库根几乎不变；跟踪列表变化慢；status 变化最快。 */
const GIT_ROOT_TTL = 60_000
const GIT_TRACKED_TTL = 15_000
const GIT_DIRTY_TTL = 5_000
const gitRootCache = new Map() // cwd -> { root, cwdRel, at }
const gitTrackedCache = new Map() // cwd -> { files, at }
const gitDirtyCache = new Map() // cwd -> { dirty, at }
const extrasCache = new Map() // cwd -> { extras, at }（.aiinclude 收集结果，与 tracked 同 TTL）

/** 读取 TTL 缓存条目；未过期返回条目，过期或缺失返回 null。 */
function cacheGet(map, key, ttl, now) {
  const entry = map.get(key)
  if (entry === undefined || now - entry.at >= ttl) return null
  return entry
}

/** 会话 header cwd 的持久化回退缓存：sessionId -> { cwd, at }。 */
const sessionCwdCache = new Map()
const SESSION_CWD_TTL = 60_000

/**
 * 从持久化层解析会话的 cwd（ctx.sessions 内存注册表缺失时使用，如历史对话）。
 * 返回 undefined 表示解析失败；结果按 sessionId 缓存 60s。
 */
async function resolveCwdFromPersistence(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const memo = sessionCwdCache.get(sessionId)
  if (memo !== undefined && Date.now() - memo.at < SESSION_CWD_TTL) return memo.cwd
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  let cwd
  try {
    const info = await persistence.inspect(sessionId)
    // SessionInspection 结构取 header 字段（meta/header/sessionHeader 均防御）
    const meta =
      info !== null && typeof info === 'object'
        ? info.meta ?? info.header ?? info.sessionHeader ?? info.session?.header
        : undefined
    cwd = meta !== null && typeof meta === 'object' && typeof meta.cwd === 'string' ? meta.cwd : undefined
  } catch {
    cwd = undefined
  }
  sessionCwdCache.set(sessionId, { cwd, at: Date.now() })
  return cwd
}

/** 路径统一为正斜杠形式。 */
function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : ''
}

/** 安全读取文本文件；不存在或非文件返回 undefined。 */
async function readTextSafe(fs, path) {
  try {
    const target = await fs.resolve(path)
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * 递归遍历收集命中的文件。
 *
 * - `includeFile(p)`：文件级命中判定（仅在未被继承时检查）。
 * - `inheritDir(p)`：目录级规则状态，返回 true（纳入并继承给子级）、
 *   false（显式排除，阻断继承）或 null（无规则，沿用父级继承状态）。
 *   这是 .aiinclude 目录规则（doc/）与否定规则（!doc/private/）的语义基础。
 * - `mayContain(p)`：可选剪枝判定；目录不可能通往任何命中时跳过递归，
 *   大幅降低 .aiinclude 目录规则场景的遍历开销。
 */
async function walkFiles(fs, dirTarget, includeFile, inheritDir, mayContain) {
  const out = []
  const walk = async (target, relPath, level, inherited) => {
    if (out.length >= CAP || level > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.listDir(target)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= CAP) return
      if (entry.type === 'directory') {
        const p = relPath === '' ? entry.name : relPath + '/' + entry.name
        let matched = inherited
        if (inheritDir !== null && inheritDir !== undefined) {
          const state = inheritDir(p)
          if (state !== null) matched = state
        }
        if (SKIP.has(entry.name) && !matched) continue
        if (!matched && mayContain !== undefined && mayContain !== null && !mayContain(p)) continue
        await walk(entry.target, p, level + 1, matched)
      } else if (entry.type === 'file') {
        const p = relPath === '' ? entry.name : relPath + '/' + entry.name
        if (inherited || includeFile(p)) out.push(p)
      }
    }
  }
  await walk(dirTarget, '', 0, false)
  return out
}

/** 运行 git 命令并返回 stdout；失败或非零退出返回 undefined。 */
async function runGit(ctx, cwd, args) {
  const sp = ctx.get('subprocess')
  if (sp === undefined) return undefined
  try {
    const handle = sp.spawn({
      argv: ['git', ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 5000,
    })
    const outcome = await handle.done
    const text = handle.collected.stdout !== undefined ? handle.collected.stdout.readFrom(0).text : ''
    return outcome.exitCode === 0 ? text : undefined
  } catch (error) {
    console.error('[file-mention] git failed:', error)
    return undefined
  }
}

/** 读取 JSON 请求体；为空或解析失败返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk
    total += part.length
    if (total > BODY_CAP_BYTES) {
      req.destroy()
      return null
    }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 写入 JSON 响应。 */
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** 嵌套 .aiinclude 规则合并结果的缓存 TTL（毫秒）。 */
const AI_MEMO_TTL = 60_000
/** 嵌套 .aiinclude 发现数量上限（防御性）。 */
const AI_NESTED_CAP = 50
/** 嵌套规则合并缓存：cwd → { at, rules }。 */
const aiMemo = new Map()

/**
 * 全量遍历（仅跳过 SKIP 目录）发现各子目录中的 `.aiinclude` 文件，
 * 返回其所在目录列表（根相对路径）。用于加载嵌套配置。
 */
async function discoverNestedAiinclude(fs, root) {
  const dirs = []
  const walk = async (target, relPath, level) => {
    if (dirs.length >= AI_NESTED_CAP || level >= MAX_DEPTH) return
    let entries
    try {
      entries = await fs.listDir(target)
    } catch {
      return
    }
    for (const entry of entries) {
      if (dirs.length >= AI_NESTED_CAP) return
      if (entry.type === 'directory') {
        if (SKIP.has(entry.name)) continue
        await walk(entry.target, relPath === '' ? entry.name : relPath + '/' + entry.name, level + 1)
      } else if (entry.type === 'file' && entry.name === '.aiinclude') {
        if (relPath !== '') dirs.push(relPath)
      }
    }
  }
  await walk(root, '', 0)
  return dirs
}

/**
 * 加载工作区的 .aiinclude 规则（根 + 嵌套，合并为单一规则集）。
 *
 * - 根 .aiinclude 不存在 → 返回 null（不启用 .aiinclude 逻辑，零开销）。
 * - 根存在 → 全量发现嵌套 .aiinclude（SKIP 目录内的不读），规则展平为根相对
 *   后按行序追加，last-match-wins 使嵌套规则覆盖根规则；`!` 否定同样参与，
 *   与遍历继承逻辑（inheritDir）自然协作。
 * - 结果按 cwd 内存缓存 AI_MEMO_TTL（60s），避免每次请求重复全量扫描。
 */
async function loadAiRules(fs, cwd, root) {
  const memo = aiMemo.get(cwd)
  if (memo !== undefined && Date.now() - memo.at < AI_MEMO_TTL) return memo.rules
  const rootText = await readTextSafe(fs, cwd + '/.aiinclude')
  const lines = []
  if (rootText !== undefined) {
    lines.push(...rootText.split(/\r?\n/))
    const nestedDirs = await discoverNestedAiinclude(fs, root)
    for (const dir of nestedDirs) {
      const text = await readTextSafe(fs, cwd + '/' + dir + '/.aiinclude')
      if (text !== undefined) lines.push(...flattenNestedRules(dir, text.split(/\r?\n/)))
    }
  }
  const rules = lines.length > 0 ? compileRules(lines) : null
  aiMemo.set(cwd, { at: Date.now(), rules })
  return rules
}

function apply(ctx) {
  const handler = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.writeHead(415)
      res.end()
      return
    }
    const body = await readJsonBody(req)
    const args = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
    const sessionId =
      args !== null && typeof args === 'object' && typeof args.sessionId === 'string'
        ? args.sessionId
        : undefined
    const session = sessionId !== undefined ? ctx.sessions.get(sessionId) : undefined
    let cwd = session !== undefined && session.header !== undefined ? session.header.cwd : undefined
    if (typeof cwd !== 'string' || cwd.length === 0) {
      // 内存注册表（ctx.sessions）只含活跃/已恢复会话；左侧历史对话不在其中时，
      // 回退到持久化层读取会话 header 拿 cwd（60s 缓存，避免每次请求读盘）。
      cwd = await resolveCwdFromPersistence(ctx, sessionId)
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      json(res, { files: [] })
      return
    }
    const fs = ctx.get('fs')
    if (fs === undefined) {
      json(res, { files: [] })
      return
    }
    try {
      const root = await fs.resolve(cwd)
      let files = []
      let dirty = []

      // 1) git 跟踪文件：天然遵守 .gitignore，排除编译产物与未跟踪文件
      //    结果分层缓存（root 60s / tracked 15s / dirty 5s），TTL 内不重复跑 git 子进程；
      //    陈旧上限即 TTL，客户端侧 30s SWR 缓存比它更"旧"，因此整体一致性不受影响。
      const now = Date.now()
      const rootEntry = cacheGet(gitRootCache, cwd, GIT_ROOT_TTL, now)
      let repoRoot = ''
      let cwdRelFromRepo = ''
      if (rootEntry !== null) {
        repoRoot = rootEntry.root
        cwdRelFromRepo = rootEntry.cwdRel
      } else {
        const rootText = await runGit(ctx, cwd, ['rev-parse', '--show-toplevel'])
        if (rootText !== undefined) {
          repoRoot = norm(rootText.trim())
          cwdRelFromRepo =
            repoRoot !== '' && norm(cwd).startsWith(repoRoot + '/')
              ? norm(cwd).slice(repoRoot.length + 1)
              : ''
        }
        // 非仓库也缓存（root=''），60s 内不再重复探测；git init 后最多 60s 识别
        gitRootCache.set(cwd, { root: repoRoot, cwdRel: cwdRelFromRepo, at: now })
      }

      const trackedEntry = cacheGet(gitTrackedCache, cwd, GIT_TRACKED_TTL, now)
      if (trackedEntry !== null) {
        files = trackedEntry.files
      } else if (repoRoot !== '') {
        const trackedText = await runGit(ctx, cwd, ['ls-files', '-c'])
        if (trackedText !== undefined) {
          files = trackedText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '')
            .filter((p) => cwdRelFromRepo === '' || p.startsWith(cwdRelFromRepo + '/'))
            .map((p) => (cwdRelFromRepo === '' ? p : p.slice(cwdRelFromRepo.length + 1)))
          gitTrackedCache.set(cwd, { files, at: Date.now() })
        }
      } else {
        // 回退：git 不可用/非仓库时，解析 .gitignore 后全量扫描（结果同样缓存 15s）
        const ignoreText = await readTextSafe(fs, cwd + '/.gitignore')
        const rules = compileRules(ignoreText !== undefined ? ignoreText.split(/\r?\n/) : [])
        files = await walkFiles(fs, root, (p) => !matchRules(rules, p, false), null)
        gitTrackedCache.set(cwd, { files, at: Date.now() })
      }

      // 1b) 未提交变更（staged + unstaged + 删除 + 未跟踪）：@ 默认排序优先展示
      const dirtyEntry = cacheGet(gitDirtyCache, cwd, GIT_DIRTY_TTL, now)
      if (dirtyEntry !== null) {
        dirty = dirtyEntry.dirty
      } else if (repoRoot !== '') {
        const statusText = await runGit(ctx, cwd, ['status', '--porcelain', '-z'])
        if (statusText !== undefined) {
          dirty = parseStatusZ(statusText)
            .filter((p) => cwdRelFromRepo === '' || p.startsWith(cwdRelFromRepo + '/'))
            .map((p) => (cwdRelFromRepo === '' ? p : p.slice(cwdRelFromRepo.length + 1)))
          gitDirtyCache.set(cwd, { dirty, at: Date.now() })
        }
      }

      // 2) .aiinclude：重新纳入被忽略/未跟踪但 AI 需要的文件（支持子目录嵌套配置）
      //    extras 收集结果同样缓存 15s（与 tracked 同 TTL）——该 walk 遍历 doc/ 级
      //    子树（实测 ~370ms/次），是热请求的大头；aiRules 为 null（无配置）时
      //    整个逻辑跳过，因此缓存不会在配置被删除后残留。
      const aiRules = await loadAiRules(fs, cwd, root)
      if (aiRules !== null) {
        let extras
        const extrasEntry = cacheGet(extrasCache, cwd, GIT_TRACKED_TTL, now)
        if (extrasEntry !== null) {
          extras = extrasEntry.extras
        } else {
          extras = await walkFiles(
            fs,
            root,
            (p) => matchRules(aiRules, p, false),
            (p) => {
              const win = lastMatchRule(aiRules, p, true)
              return win === undefined ? null : !win.negate
            },
            (p) => dirMayLeadToMatch(aiRules, p),
          )
          extrasCache.set(cwd, { extras, at: Date.now() })
        }
        const seen = new Set(files)
        for (const p of extras) {
          if (!seen.has(p)) {
            seen.add(p)
            files.push(p)
          }
        }
      }

      files = files.filter((p) => p !== '' && !p.endsWith('/')).slice(0, CAP).sort()
      // cwd 用于客户端按工作区共享缓存（同工作区多会话只扫描一次）
      json(res, { files, dirty, cwd })
    } catch (error) {
      console.error('[file-mention] list failed:', error)
      json(res, { files: [], dirty: [] })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/file-mention/list', handler }),
    'file-mention: /file-mention/list route',
  )
}

export { name, inject, apply }
