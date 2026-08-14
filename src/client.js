/**
 * dsh-file-mention —— Client 半体
 *
 * 注册 '@' 输入触发源（与技能 / 菜单、@pluginId、@子代理 同一套 inputTriggers 机制）：
 *   - 输入 @ 弹出 file 分组，按文件名/路径实时过滤
 *   - 选中后插入 `@相对路径 ` 到输入框，模型看到路径后直接读取文件
 *   - 列表经 Host 的 /file-mention/list HTTP 路由获取；缓存按工作区 cwd 共享
 *     （同工作区多会话只扫描一次，30 秒 TTL），旧版 Host 无 cwd 时退化为按会话缓存
 *
 * 构建时由 scripts/build.mjs 将 src/core.js 内联，并包装为
 * `window.__ModuleLoader__.load({ id, factory })` 经典脚本格式。
 */
import { filterFiles } from './core.js'

const name = 'dsh-file-mention'
const inject = ['inputTriggers']

function apply(ctx) {
  // 共享缓存：键为工作区 cwd（同工作区多会话只扫描一次，30s TTL）；
  // 旧版 Host 响应无 cwd 时退化为按 sessionId 缓存。
  const fetches = new Map() // cwd|sessionId -> { promise, at }
  const sessionCwd = new Map() // sessionId -> cwd（首次响应后得知）
  const pending = new Map() // sessionId -> promise（在途请求去重）
  const TTL = 30000

  const fetchFiles = (sessionId) => {
    const key = sessionCwd.get(sessionId) ?? sessionId
    const hit = fetches.get(key)
    if (hit !== undefined && Date.now() - hit.at < TTL) return hit.promise
    if (hit !== undefined) fetches.delete(key)
    const inflight = pending.get(sessionId)
    if (inflight !== undefined) return inflight
    const promise = fetch('/file-mention/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((value) => {
        const obj = value !== null && typeof value === 'object' ? value : {}
        return {
          files: Array.isArray(obj.files) ? obj.files : [],
          dirty: Array.isArray(obj.dirty) ? obj.dirty : [],
          cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        }
      })
      .catch((error) => {
        console.error('[file-mention] host list failed:', error)
        return { files: [], dirty: [], cwd: undefined }
      })
    pending.set(sessionId, promise)
    promise.then(
      (value) => {
        pending.delete(sessionId)
        if (value.cwd !== undefined) sessionCwd.set(sessionId, value.cwd)
        fetches.set(value.cwd ?? sessionId, { promise, at: Date.now() })
      },
      () => pending.delete(sessionId),
    )
    return promise
  }

  const source = {
    trigger: '@',
    name: 'file',
    order: 4,
    // 预热：会话控制器创建（页面加载/切换会话）时后台预取一次，
    // 输入 @ 时命中 30s 缓存，避免首次等待文件遍历
    warm(session) {
      fetchFiles(session.sessionId).catch(() => {})
    },
    async candidates(session, { query, signal }) {
      const { files, dirty } = await fetchFiles(session.sessionId)
      if (signal !== undefined && signal.aborted) return []
      return filterFiles(files, query, 100, new Set(dirty)).map((f) => ({
        name: f.slice(f.lastIndexOf('/') + 1),
        description: f,
        icon: '\ud83d\udcc4',
      }))
    },
    onPick({ candidate }) {
      return { text: '@' + candidate.description + ' ' }
    },
  }

  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'file-mention: @ source')
}

export { name, inject, apply }
