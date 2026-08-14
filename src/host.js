/**
 * dsh-file-mention —— Host 半体
 *
 * 提供 Package-private RPC `fileMention.list`：
 *   - 解析会话工作区（ctx.sessions）
 *   - 通过 git ls-files 列出跟踪文件（天然遵守 .gitignore，排除编译产物与未跟踪文件）
 *   - 读取工作区根目录 .aiinclude，把被忽略但 AI 需要的文件重新纳入
 *   - git 不可用/非仓库时回退为 .gitignore 解析 + 全量扫描
 *
 * 构建时由 scripts/build.mjs 将 src/core.js 内联进来，产物无任何外部依赖。
 */
import { compileRules, matchRules, lastMatchRule } from './core.js'

const name = 'dsh-file-mention'
const inject = ['sessions']

/** 遍历时跳过的重型目录（.aiinclude 命中可覆盖）。 */
const SKIP = new Set([
  '.git', 'node_modules', '.gradle', '.idea', '.kotlin', '.cxx',
  '.externalNativeBuild', 'build', 'out', 'target', 'dist', 'release',
  'debug', '.dsh', '.agents', '.claude', '.codex', 'storages', 'sessions',
])
/** 文件总数上限。 */
const CAP = 3000
/** 遍历深度上限（doc 等深层目录可达 13 层）。 */
const MAX_DEPTH = 16

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
 */
async function walkFiles(fs, dirTarget, includeFile, inheritDir) {
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

function apply(ctx) {
  harness.handle('fileMention.list', async (args) => {
    const sessionId =
      args !== null && typeof args === 'object' && typeof args.sessionId === 'string'
        ? args.sessionId
        : undefined
    const session = sessionId !== undefined ? ctx.sessions.get(sessionId) : undefined
    const cwd = session !== undefined && session.header !== undefined ? session.header.cwd : undefined
    if (typeof cwd !== 'string' || cwd.length === 0) return { files: [] }
    const fs = ctx.get('fs')
    if (fs === undefined) return { files: [] }
    try {
      const root = await fs.resolve(cwd)
      let files = []

      // 1) git 跟踪文件：天然遵守 .gitignore，排除编译产物与未跟踪文件
      const rootText = await runGit(ctx, cwd, ['rev-parse', '--show-toplevel'])
      const trackedText = rootText !== undefined ? await runGit(ctx, cwd, ['ls-files', '-c']) : undefined
      if (trackedText !== undefined) {
        const repoRoot = norm(rootText.trim())
        const cwdRelFromRepo =
          repoRoot !== '' && norm(cwd).startsWith(repoRoot + '/')
            ? norm(cwd).slice(repoRoot.length + 1)
            : ''
        files = trackedText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .filter((p) => cwdRelFromRepo === '' || p.startsWith(cwdRelFromRepo + '/'))
          .map((p) => (cwdRelFromRepo === '' ? p : p.slice(cwdRelFromRepo.length + 1)))
      } else {
        // 回退：git 不可用/非仓库时，解析 .gitignore 后全量扫描
        const ignoreText = await readTextSafe(fs, cwd + '/.gitignore')
        const rules = compileRules(ignoreText !== undefined ? ignoreText.split(/\r?\n/) : [])
        files = await walkFiles(fs, root, (p) => !matchRules(rules, p, false), null)
      }

      // 2) .aiinclude：重新纳入被忽略/未跟踪但 AI 需要的文件
      const aiText = await readTextSafe(fs, cwd + '/.aiinclude')
      if (aiText !== undefined) {
        const aiRules = compileRules(aiText.split(/\r?\n/))
        const extras = await walkFiles(
          fs,
          root,
          (p) => matchRules(aiRules, p, false),
          (p) => {
            const win = lastMatchRule(aiRules, p, true)
            return win === undefined ? null : !win.negate
          },
        )
        const seen = new Set(files)
        for (const p of extras) {
          if (!seen.has(p)) {
            seen.add(p)
            files.push(p)
          }
        }
      }

      files = files.filter((p) => p !== '' && !p.endsWith('/')).slice(0, CAP).sort()
      return { files }
    } catch (error) {
      console.error('[file-mention] list failed:', error)
      return { files: [] }
    }
  })
}

export { name, inject, apply }
