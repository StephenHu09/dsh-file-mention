/**
 * dsh-file-mention —— Client 半体
 *
 * 注册 '@' 输入触发源（与技能 / 菜单、@pluginId、@子代理 同一套 inputTriggers 机制）：
 *   - 输入 @ 弹出 file 分组，按文件名/路径实时过滤
 *   - 选中后插入 `@相对路径 ` 到输入框，模型看到路径后直接读取文件
 *   - 列表经 Host 的 /file-mention/list HTTP 路由获取；缓存按工作区 cwd 共享
 *     （同工作区多会话只扫描一次），stale-while-revalidate：TTL(30s) 过期后先返回
 *     旧列表并后台刷新，@ 永远零等待；旧版 Host 无 cwd 时退化为按会话缓存
 *
 * 构建时由 scripts/build.mjs 将 src/core.js 内联，并包装为
 * `window.__ModuleLoader__.load({ id, factory })` 经典脚本格式。
 */
import { filterFiles, fileIcon, deriveDirs } from './core.js'

const name = '@hucj/dsh-file-mention'
const inject = ['inputTriggers']

function apply(ctx) {
  // 共享缓存：键为工作区 cwd（同工作区多会话只扫描一次）；stale-while-revalidate——
  // TTL 过期后先返回旧数据（@ 零等待），后台刷新；旧版 Host 无 cwd 时退化为按 sessionId 缓存。
  const fetches = new Map() // cwd|sessionId -> { promise, data, at }
  const sessionCwd = new Map() // sessionId -> cwd（首次响应后得知）
  const pending = new Map() // sessionId -> promise（在途请求去重）
  const refreshing = new Set() // key：stale 后台刷新去重
  const TTL = 30000

  const parse = (value) => {
    const obj = value !== null && typeof value === 'object' ? value : {}
    return {
      files: Array.isArray(obj.files) ? obj.files : [],
      // 新版 Host：dirty 为 [{ path, status }]；兼容旧版 Host 的 string[]（视为未跟踪）
      dirty: Array.isArray(obj.dirty)
        ? obj.dirty.map((d) => (typeof d === 'string' ? { path: d, status: 'A' } : d))
        : [],
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    }
  }

  /** 发起真实请求并在成功后写入缓存；失败时回退旧数据（若有）。 */
  const fetchFresh = (key, sessionId) => {
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
      .then(parse)
      .catch((error) => {
        console.error('[file-mention] host list failed:', error)
        const existing = fetches.get(key)
        return existing !== undefined && existing.data !== undefined
          ? existing.data
          : { files: [], dirty: [], cwd: undefined }
      })
    pending.set(sessionId, promise)
    promise.then(
      (value) => {
        pending.delete(sessionId)
        if (value.cwd !== undefined) sessionCwd.set(sessionId, value.cwd)
        // 无效响应（会话未就绪/未知 → 空列表且无 cwd）不缓存：
        // 避免空结果粘性（30s 内 @ 一直空），下次调用直接重新请求。
        if (value.cwd !== undefined || value.files.length > 0) {
          fetches.set(value.cwd ?? key, { promise, data: value, at: Date.now() })
        }
      },
      () => pending.delete(sessionId),
    )
    return promise
  }

  /**
   * 取列表：有缓存数据时立即返回（TTL 内直接命中；过期则返回 stale 并后台刷新），
   * 无缓存时才等待真实请求——@ 菜单在任意时刻都不再等待网络。
   */
  const fetchFiles = (sessionId) => {
    const key = sessionCwd.get(sessionId) ?? sessionId
    const hit = fetches.get(key)
    if (hit !== undefined && hit.data !== undefined) {
      if (Date.now() - hit.at >= TTL && !refreshing.has(key)) {
        refreshing.add(key)
        fetchFresh(key, sessionId).finally(() => refreshing.delete(key))
      }
      return Promise.resolve(hit.data)
    }
    if (hit !== undefined) return hit.promise // 在途（尚无数据）
    return fetchFresh(key, sessionId)
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
      // dirty 仅用于「未提交变更优先」排序；目录由文件列表派生（deriveDirs），
      // 与文件混排（目录 rank 1，与普通文件同层；变更文件仍置顶）
      const dirtySet = new Set(dirty.map((d) => d.path))
      const dirs = deriveDirs(files)
      return filterFiles([...dirs, ...files], query, 100, dirtySet).map((f) => {
        const isDir = f.endsWith('/')
        const base = (isDir ? f.slice(0, -1) : f).slice(f.lastIndexOf('/') + 1)
        return {
          // 目录名带尾斜杠（如 `docs/`）与文件视觉区分；description 保持可插入路径
          name: isDir ? base + '/' : base,
          description: f,
          icon: isDir ? '📁' : fileIcon(f),
        }
      })
    },
    onPick({ candidate }) {
      return { text: '@' + candidate.description + ' ' }
    },
  }

  // 菜单显示适配（@ 候选菜单，MenuView）：
  // 官方 CSS Module 限制——菜单 max-width min(537px, 100%)、行高 40px/padding 8px 10px、
  // 行字号 14px、name 列 flex:none + max-width:40%（长文件名把尾部 [M] 标记截断）。
  // 用高特异性选择器（0,1,1 > 官方 0,1,0）覆盖，不受样式加载顺序影响：
  //   - 菜单加宽到 min(720px, 100%)，name 可用宽 215px → 288px（变更标记可见字符 ~28 → ~41）
  //   - 行字号 14px → 13px，每行可见字符 +8%
  //   - 行高压缩（min-height 40→32px、padding 8px→4px 8px、line-height 22→18px），
  //     320px 菜单从 8 行增至 10 行（+25% 内容量）
  const menuStyle = document.createElement('style')
  menuStyle.dataset.plugin = name
  menuStyle.textContent = [
    'div[role="listbox"]{max-width:min(720px,100%)}',
    'button[role="option"]{font-size:13px;line-height:18px;min-height:32px;padding:4px 8px}',
    'div[role="presentation"]{padding:4px 8px}',
  ].join('\n')
  ctx.effect(() => {
    document.head.appendChild(menuStyle)
    return () => menuStyle.remove()
  }, 'file-mention: candidate menu style')

  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'file-mention: @ source')
}

export { name, inject, apply }
