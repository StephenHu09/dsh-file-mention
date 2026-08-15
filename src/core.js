/**
 * dsh-file-mention —— 规则匹配核心（纯函数，零依赖，可独立测试）
 *
 * 实现 gitignore/.aiinclude 风格的路径匹配子集：
 *   - `#` 注释、空行忽略
 *   - `!` 前缀表示否定（最后匹配者生效）
 *   - 末尾 `/` 表示仅目录
 *   - 开头 `/` 表示锚定于基准目录
 *   - 含 `/` 的模式按完整相对路径匹配；不含 `/` 的模式按 basename 任意层级匹配
 *   - `*` 匹配段内任意字符、`?` 匹配单字符、`**` 跨段匹配
 */

/** 段 → 正则片段：支持 *（段内任意）、?（单字符），其余按字面量转义。 */
function segmentToRegex(seg) {
  let out = ''
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

/** 编译规则行集合为可复用的匹配规则数组。 */
export function compileRules(lines) {
  const rules = []
  for (let raw of lines) {
    raw = raw.trim()
    if (raw === '' || raw.startsWith('#')) continue
    let negate = false
    if (raw.startsWith('!')) {
      negate = true
      raw = raw.slice(1).trim()
    }
    if (raw === '') continue
    const dirOnly = raw.endsWith('/')
    if (dirOnly) raw = raw.slice(0, -1)
    let anchored = raw.startsWith('/')
    if (anchored) raw = raw.slice(1)
    if (raw === '') continue
    const hasSlash = raw.includes('/')
    try {
      // 逐段编译：完整正则（匹配）+ 段列表（剪枝判定用）
      const segs = raw.split('/').map((seg) => {
        if (seg === '**') return { star: true, re: null }
        return { star: false, re: new RegExp('^' + segmentToRegex(seg) + '$') }
      })
      const src = segs.map((s) => (s.star ? '(?:.*)' : s.re.source.slice(1, -1))).join('/')
      rules.push({ negate, dirOnly, anchored, hasSlash, segs, re: new RegExp('^' + src + '$') })
    } catch {
      // 非法模式跳过
    }
  }
  return rules
}

/**
 * 剪枝判定：目录 relPath 是否**可能**通往某条规则的命中？
 * 为 false 时遍历可以安全跳过该目录（.aiinclude 目录规则场景可大幅减负）。
 *
 * - basename 非目录规则（如 `*.log`）：任意层级都可能命中 → 恒 true（不可剪枝）
 * - basename 目录规则（如 `doc/`）：仅目录名匹配时才有意义
 * - 锚定/含斜杠规则（如 `app/build/**`）：目录是某规则段序列的前缀时才可能
 */
export function dirMayLeadToMatch(rules, relPath) {
  const pathSegs = relPath.split('/')
  for (const r of rules) {
    if (r.anchored || r.hasSlash) {
      // 段前缀匹配：pathSegs 必须逐段命中规则段前缀；'**' 通吃其后
      let ok = true
      for (let i = 0; i < pathSegs.length; i++) {
        const p = r.segs[i]
        if (p === undefined) {
          ok = false
          break
        }
        if (p.star) break
        if (!p.re.test(pathSegs[i])) {
          ok = false
          break
        }
      }
      if (ok) return true
    } else if (!r.dirOnly) {
      // basename 文件规则：任何目录都可能包含命中文件
      return true
    } else {
      // basename 目录规则：目录名命中即会继承
      const name = pathSegs[pathSegs.length - 1]
      if (r.re.test(name)) return true
    }
  }
  return false
}

/**
 * 返回 rel 命中的最后一条规则（gitignore 语义：最后匹配者生效）；
 * 未命中返回 undefined。
 */
export function lastMatchRule(rules, rel, isDir) {
  let win
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.anchored || r.hasSlash) {
      if (r.re.test(rel)) win = r
    } else {
      const base = rel.slice(rel.lastIndexOf('/') + 1)
      if (r.re.test(base) || r.re.test(rel)) win = r
    }
  }
  return win
}

/** 判断相对路径 rel 是否命中规则集（最后匹配者生效，未命中为 false）。 */
export function matchRules(rules, rel, isDir) {
  const win = lastMatchRule(rules, rel, isDir)
  return win !== undefined ? !win.negate : false
}

/**
 * 解析 `git status --porcelain -z` 输出为变更文件列表（含归一化状态码）。
 * 每条 `<XY> <path>\0`；重命名/复制（R/C）占两个字段：真实 git -z 格式为
 * `R  NEW\0OLD\0`（**新路径在前**、原路径在后），取当前条目（新路径），
 * 原路径字段直接跳过。路径含空格等特殊字符时依然精确（-z 不做引号转义）。
 *
 * 状态码归一化（客户端用于行尾字母标记）：
 *   `??` 未跟踪 → A；X/Y 任一侧 A → A、D → D、R/C → R；其余（M/U/T/冲突）→ M。
 * 重命名/复制的原路径字段（旧路径）也输出为 `{ path, status: 'D' }`：
 *   旧文件已被移走/删除，状态数据保持完整（git 的 rename 检测可能把「同内容的
 *   新增+删除」配对成 R——此时原路径对应的删除文件若单独出现会丢失其 D 状态）。
 */
export function parseStatusZ(text) {
  const dirty = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry === '') continue
    const code = entry[0]
    const x = entry[1]
    if (code === 'R' || code === 'C') {
      const path = entry.slice(3)
      if (path !== '') dirty.push({ path, status: 'R' })
      const oldPath = parts[i + 1]
      if (oldPath !== undefined && oldPath !== '') {
        dirty.push({ path: oldPath, status: 'D' })
      }
      i += 1 // 跳过原路径字段（纯路径段，无状态码，不能被误当条目）
    } else if (code === '?' && x === '?') {
      const path = entry.slice(3)
      if (path !== '') dirty.push({ path, status: 'A' })
    } else {
      // XY 两字符后是分隔空格：X=index 状态（entry[0]），Y=worktree 状态（entry[1]）
      let status = 'M'
      for (const s of [code, entry[1]]) {
        if (s === 'A') { status = 'A'; break }
        if (s === 'D') { status = 'D'; break }
        if (s === 'R' || s === 'C') { status = 'R'; break }
      }
      const path = entry.slice(3)
      if (path !== '') dirty.push({ path, status })
    }
  }
  return dirty
}

/**
 * 将仓库根相对路径列表裁剪为 cwd 相对路径（git status --porcelain 在子目录
 * 输出仓库根相对路径，与 git ls-files 的 cwd 相对不对称；prefix 来自
 * `git rev-parse --show-prefix`，含尾部斜杠，如 `sub/`）。
 * 不在 prefix 之下的路径（cwd 外）直接丢弃。
 * 元素可为 string（路径）或 { path, ... }（结构化条目），裁剪后保持原形态。
 */
export function stripRepoPrefix(paths, prefix) {
  if (prefix === '') return paths
  return paths
    .map((item) => {
      const path = typeof item === 'string' ? item : item.path
      if (!path.startsWith(prefix)) return null
      const rel = path.slice(prefix.length)
      return typeof item === 'string' ? rel : { ...item, path: rel }
    })
    .filter((x) => x !== null)
}

/**
 * 文件类型图标（4 类 emoji，按扩展名映射；DSH 菜单 icon 为纯文本渲染）。
 * 代码 / 文档 / 图片 / 其他；未知扩展名与隐藏文件归「其他」。
 */
const FILE_ICONS = { code: '⌨️', doc: '📝', image: '🖼️', other: '📄' }
const ICON_EXTS = {
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  kt: 'code', java: 'code', py: 'code', go: 'code', rs: 'code',
  c: 'code', cpp: 'code', h: 'code', sh: 'code', bat: 'code', ps1: 'code',
  md: 'doc', txt: 'doc', rst: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', svg: 'image', webp: 'image', gif: 'image', ico: 'image',
}
export function fileIcon(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()
  return FILE_ICONS[ICON_EXTS[ext]] ?? FILE_ICONS.other
}

/**
 * 按查询词过滤文件列表：匹配 basename 或完整路径（大小写不敏感）。
 * 客户端 @ 菜单的过滤逻辑，独立出来以便测试。
 *
 * 命中排序（score 升序 + rank 升序 + 组内字母序）：
 *   score 0. 精确匹配（完整路径或 basename 与查询词完全相等）
 *   score 1. 前缀匹配（完整路径或 basename 以查询词开头）
 *   score 2. 子串匹配（其余命中项）
 *   rank 0.  git 未提交变更（dirty 集合内）
 *   rank 1.  非隐藏目录（首段不以 . 开头）
 *   rank 2.  隐藏目录
 * 空查询时 score 恒为 0，退化为纯 rank + 字母序（与历史行为一致）。
 */
/**
 * 从文件列表派生全部父目录（相对路径、尾斜杠、去重、字母序）。
 * 目录引用不需要额外扫描：files 已含工作区全部可见文件，其父目录链即完整目录集合
 * （空目录 git 不跟踪、菜单也无意义）。
 * @param {string[]} files 文件路径列表（正斜杠相对路径）
 * @returns {string[]} 目录路径列表，如 `docs/`、`docs/images/`
 */
export function deriveDirs(files) {
  const dirs = new Set()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i !== -1) {
      dirs.add(f.slice(0, i + 1))
      i = f.indexOf('/', i + 1)
    }
  }
  return [...dirs].sort()
}

/** basename 提取（目录路径尾斜杠先剥离，如 `docs/` → `docs`）。 */
function baseName(f) {
  const p = f.endsWith('/') ? f.slice(0, -1) : f
  return p.slice(p.lastIndexOf('/') + 1)
}

/**
 * 目录逐级展开：显示的目录深度上限 = 查询词中 `/` 数量 + 1。
 *   - `@app`（无斜杠）→ 只显示顶层目录（app/）
 *   - `@app/`（进入 app）→ 只显示第二层（app/ 的直接子目录，如 app/src/），
 *     更深的 app/src/main/ 不显示——逐级浏览，避免深层子目录排队刷屏
 *   - `@app/src/` → 第三层（app/src/ 的直接子目录）
 * 例外：单段查询时，**basename 以查询词开头的深层目录突破深度限制**——
 *   如 `@10_logcat_analyze` 直达 `docs/10_logcat_analyze/`（快速关联子目录，无需输入完整路径）。
 * 深层目录在 filterFiles 按查询词匹配过滤后不会串味；返回的是「允许展示」的目录全集。
 * @param {string[]} dirs 全量目录（deriveDirs 输出，尾斜杠）
 * @param {string} [query] 当前查询词
 * @returns {string[]} 应展示的目录
 */
export function visibleDirs(dirs, query) {
  const q = String(query || '').trim().toLowerCase()
  const depth = (q.match(/\//g) || []).length + 1
  return dirs.filter((d) => {
    const segments = d.slice(0, -1).split('/')
    if (segments.length <= depth) return true
    // 快速关联子目录：单段查询时，basename 以查询词开头的深层目录放行
    // （startsWith 而非 includes，避免短查询词放行大量无关目录）
    if (q !== '' && !q.includes('/')) {
      return segments[segments.length - 1].startsWith(q)
    }
    return false
  })
}

/** 变更文件置顶数量上限（v0.1.14：避免变更过多时压制目录，只置顶最近修改的 N 个）。 */
export const TOP_DIRTY = 5

/**
 * 取 cmp 序最小的 k 个元素并返回有序前缀（原地修改 arr）。
 * 快速选择 O(n) 平均 + 前缀 sort，避免大组（数万项）全量排序——菜单只需前 limit 个。
 * @param {unknown[]} arr 候选数组（原地重排）
 * @param {number} k 需要的前缀长度
 * @param {(a:unknown,b:unknown)=>number} cmp 比较器（与 Array.sort 同语义）
 * @returns {unknown[]} 有序的前 k 个元素（原数组引用）
 */
function topK(arr, k, cmp) {
  if (arr.length <= k) {
    arr.sort(cmp)
    return arr
  }
  let lo = 0
  let hi = arr.length - 1
  while (lo < hi) {
    // 中位 pivot（三数取中退化处理）：输入常为已排序数组，pivot 取末尾会 O(n²)
    const mid = (lo + hi) >> 1
    const t0 = arr[mid]
    arr[mid] = arr[hi]
    arr[hi] = t0
    const pivot = arr[hi]
    let i = lo
    for (let j = lo; j < hi; j++) {
      if (cmp(arr[j], pivot) < 0) {
        const t = arr[i]
        arr[i] = arr[j]
        arr[j] = t
        i++
      }
    }
    arr[hi] = arr[i]
    arr[i] = pivot
    if (i === k) break
    if (i < k) lo = i + 1
    else hi = i - 1
  }
  return arr.slice(0, k).sort(cmp)
}

/**
 * 预计算路径元数据索引（v0.1.14 性能）：files 列表不变时可复用，避免每次按键
 * 对数万路径重复 toLowerCase/split——大仓库（3 万文件）下 filterFiles 从 ~30ms 降到 ~5ms。
 *
 * 段索引（segment index）：路径按 `/` 拆段，段名按小写首字符分桶（segBuckets:
 * Map<首字符, 段名[]>）+ 段名 → 路径倒排（segments: Map<段名, path[]>）。
 * 单段查询（如 `@seal`）只遍历首字符桶（路径数的 ~1/26），中段子串命中从全扫描
 * O(路径数×长度) 降到 O(桶大小)——3 万文件 `@seal` ~20ms → ~2ms。
 * @param {string[]} files 文件/目录路径列表
 * @returns {{lower:Map,base:Map,isDir:Map,isHidden:Map,segments:Map,segBuckets:Map}}
 *   各路径的小写/ basename 小写/目录标志/隐藏标志 + 段倒排 + 段首字符桶
 */
export function buildIndex(files) {
  const lower = new Map()
  const base = new Map()
  const isDir = new Map()
  const isHidden = new Map()
  const segments = new Map() // 段名（原样）→ 路径[]
  const segBuckets = new Map() // 段名小写首字符 → 段名[]
  for (const f of files) {
    lower.set(f, f.toLowerCase())
    base.set(f, baseName(f).toLowerCase())
    isDir.set(f, f.endsWith('/'))
    isHidden.set(f, f.split('/')[0].startsWith('.'))
    const segs = (f.endsWith('/') ? f.slice(0, -1) : f).split('/')
    for (const s of segs) {
      if (s === '') continue
      let arr = segments.get(s)
      if (arr === undefined) {
        arr = []
        segments.set(s, arr)
        const c = s[0].toLowerCase()
        let bucket = segBuckets.get(c)
        if (bucket === undefined) {
          bucket = []
          segBuckets.set(c, bucket)
        }
        bucket.push(s)
      }
      arr.push(f)
    }
  }
  // 段路径列表排序（warm 后台一次性）：单段命中时可直接按序 slice（O(n) 无 sort/topK）
  for (const arr of segments.values()) arr.sort()
  return { lower, base, isDir, isHidden, segments, segBuckets }
}

/**
 * 按查询词过滤文件/目录列表：匹配 basename 或完整路径（大小写不敏感）。
 * 客户端 @ 菜单的过滤逻辑，独立出来以便测试。
 *
 * 命中排序（score 升序 + rank 升序 + 组内字母序）：
 *   score 0. 精确匹配（完整路径或 basename 与查询词完全相等）
 *   score 1. 前缀匹配（basename 或完整路径以查询词开头）
 *   score 2. 子串匹配（basename 或完整路径包含查询词）
 *   rank 0. 未提交变更（置顶；数组形态按 mtime 降序只取前 TOP_DIRTY 个，
 *            无 mtime 的旧格式/Set 形态为全量置顶）
 *   rank 1. 目录（集中置前，便于快速选择目录引用）
 *   rank 2. 普通文件（含未置顶的其余变更文件）
 *   rank 3. 隐藏路径（首段以 `.` 开头）
 * @param {string[]} files 文件/目录路径列表
 * @param {string} [query] 查询词
 * @param {number} [limit] 返回条数上限
 * @param {Set<string>|Array<{path:string,mtime?:number}>|string[]} [dirty] 未提交变更：
 *   Set → 全量置顶；数组 → 含 mtime 时按最近修改取 TOP_DIRTY 个置顶（其余 rank 2），
 *   全部无 mtime（旧版 Host string[] 等）→ 全量置顶
 * @param {ReturnType<buildIndex>} [index] 预计算索引（files 不变时复用）
 */
export function filterFiles(files, query, limit = 100, dirty, index) {
  const q = String(query || '').trim().toLowerCase()
  let topDirty = null // Map<path, mtime>：置顶变更集（rank 0，组内按 mtime 降序）
  if (dirty instanceof Set) {
    topDirty = new Map([...dirty].map((p) => [p, undefined]))
  } else if (Array.isArray(dirty) && dirty.length > 0) {
    const entries = dirty.map((d) => (typeof d === 'string' ? { path: d } : d))
    if (entries.some((d) => typeof d.mtime === 'number')) {
      topDirty = new Map(
        [...entries]
          .sort(
            (a, b) =>
              (b.mtime ?? 0) - (a.mtime ?? 0) ||
              (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
          )
          .slice(0, TOP_DIRTY)
          .map((d) => [d.path, d.mtime]),
      )
    } else {
      topDirty = new Map(entries.map((d) => [d.path, d.mtime]))
    }
  }
  // 性能优化（v0.1.14）：短查询词匹配数千项时全量 sort 且比较器重复计算 toLowerCase
  // 导致每次按键 40ms+ 卡顿。改为：
  //   1) 按 score 分层（精确/前缀/子串），组内排序后拼接，达到 limit 即停（子串大组不排序）；
  //   2) rank 预计算缓存（比较器查表，不重复 split/startsWith）；
  //   3) 传入 buildIndex 预计算索引时，lowercase/basename/目录/隐藏标志查表（3 万文件 ~30ms → ~5ms）。
  const rankCache = new Map()
  const rankOf = (f) => {
    let r = rankCache.get(f)
    if (r !== undefined) return r
    if (topDirty !== null && topDirty.has(f)) {
      r = 0
    } else if (index !== undefined) {
      // 目录项可能不在 index（index 只覆盖 files，filterFiles 输入含 visibleDirs 目录）→ 回退
      const h = index.isHidden.get(f)
      const d = index.isDir.get(f)
      r = h !== undefined ? (h ? 3 : d ? 1 : 2)
        : f.split('/')[0].startsWith('.') ? 3
        : f.endsWith('/') ? 1
        : 2
    } else {
      r = f.split('/')[0].startsWith('.') ? 3 // 隐藏（含隐藏目录）沉底
        : f.endsWith('/') ? 1 // 目录：变更文件后、普通文件前
        : 2
    }
    rankCache.set(f, r)
    return r
  }
  const lowerOf = (f) => {
    if (index !== undefined) {
      const v = index.lower.get(f)
      if (v !== undefined) return v
    }
    return f.toLowerCase()
  }
  const baseOf = (f) => {
    if (index !== undefined) {
      const v = index.base.get(f)
      if (v !== undefined) return v
    }
    return baseName(f).toLowerCase()
  }
  const out = []
  // 12 桶（score 0..2 × rank 0..3）直接产出：桶保持输入序（有序时无需 sort/topK），
  // rank0 桶按 mtime 降序；按 score → rank 顺序取桶前缀至 limit。
  const collectBuckets = (b9) => {
    for (let s = 0; s < 3; s++) {
      const b = b9[s * 4]
      if (b.length > 1) {
        b.sort((a, c) => (topDirty?.get(c) ?? 0) - (topDirty?.get(a) ?? 0))
      }
    }
    for (let s = 0; s < 3 && out.length < limit; s++) {
      for (let r = 0; r < 4 && out.length < limit; r++) {
        const b = b9[s * 4 + r]
        const need = limit - out.length
        for (let i = 0; i < need && i < b.length; i++) out.push(b[i])
      }
    }
  }
  const groups = [[], [], []] // score 0 精确 / 1 前缀 / 2 子串（空查询全部 0）
  let needFullScan = false // 快速路径命中不足 limit → 清空结果走全扫描
  if (q === '') {
    groups[0] = [...files]
  } else if (index !== undefined && index.segBuckets !== undefined && !q.includes('/')) {
    // 段索引快速路径（单段查询）：遍历首字符桶的段名（~路径数/26），段名包含 q 的
    // 段 → 倒排路径。命中集合覆盖前缀（段前缀）与子串（段包含）语义；
    // 跨段子串（如 'b/c' 匹配 'ab/cd'）不再命中——实际查询中不存在，可忽略。
    // 恰一个命中段时（最常见：包名/目录名查询），段路径列表已排序 →
    // 按 (score, rank) 12 桶直接分流（O(n) 无 sort/topK）并直接产出；
    // 多命中段合并需去重，回退 Set+topK（走 groups 统一循环）。
    const bucket = index.segBuckets.get(q[0])
    if (bucket !== undefined) {
      const hitSegs = []
      for (const seg of bucket) {
        if (seg.toLowerCase().includes(q)) hitSegs.push(seg)
      }
      if (hitSegs.length === 1) {
        const segPaths = index.segments.get(hitSegs[0])
        if (segPaths !== undefined) {
          // 单命中段：段路径列表已排序 → 12 桶直接分流（O(n) 无 sort/topK）
          const b9 = Array.from({ length: 12 }, () => [])
          for (const f of segPaths) {
            const lower = lowerOf(f)
            const base = baseOf(f)
            const s = lower === q || base === q ? 0
              : base.startsWith(q) || lower.startsWith(q) ? 1
              : 2
            b9[s * 4 + rankOf(f)].push(f)
          }
          collectBuckets(b9)
          if (out.length >= limit) return out
          out.length = 0 // 命中不足 limit：清空，走全扫描补充
          needFullScan = true
        }
      } else if (hitSegs.length > 1) {
        const hit = new Set()
        for (const seg of hitSegs) {
          const ps = index.segments.get(seg)
          if (ps !== undefined) for (const p of ps) hit.add(p)
        }
        for (const f of hit) {
          const lower = lowerOf(f)
          const base = baseOf(f)
          if (lower === q || base === q) groups[0].push(f)
          else if (base.startsWith(q) || lower.startsWith(q)) groups[1].push(f)
          else groups[2].push(f)
        }
      }
    }
  } else if (index !== undefined && index.segBuckets !== undefined && q.includes('/')) {
    // 含 '/' 查询（用户删除路径的主场景）：q 拆段，取倒排列表最短的段缩小候选
    // （如 com/intian/seal → 'seal' 段），候选路径做「路径小写包含 q」验证——
    // 与旧语义完全一致，但候选规模从全库降到该段子树；段列表有序 → 12 桶直接产出。
    const qSegs = q.split('/').filter((s) => s !== '')
    let bestSeg = null
    let bestLen = Infinity
    for (const s of qSegs) {
      const arr = index.segments.get(s)
      if (arr !== undefined && arr.length < bestLen) {
        bestLen = arr.length
        bestSeg = s
      }
    }
    if (bestSeg === null) {
      needFullScan = true // q 段都不在索引（罕见）：全扫描
    } else {
      const segPaths = index.segments.get(bestSeg)
      const b9 = Array.from({ length: 12 }, () => [])
      for (const f of segPaths) {
        const lower = lowerOf(f)
        if (!lower.includes(q)) continue
        const base = baseOf(f)
        const s = lower === q || base === q ? 0
          : base.startsWith(q) || lower.startsWith(q) ? 1
          : 2
        b9[s * 4 + rankOf(f)].push(f)
      }
      collectBuckets(b9)
      if (out.length >= limit) return out
      out.length = 0 // 最短段命中不足 limit：清空，走全扫描补充
      needFullScan = true
    }
  } else {
    needFullScan = true // 无索引 → 全扫描
  }
  if (needFullScan) {
    // 前缀先行（startsWith 快速失败）：第一遍只收集精确/前缀命中——
    // 大仓库前缀命中通常已 ≥limit（如 @a 命中 app/ 前缀段），子串全扫描（includes，最贵）
    // 只在精确+前缀不足 limit 时才执行，避免每次按键对数万长路径做子串扫描
    for (const f of files) {
      const lower = lowerOf(f)
      const base = baseOf(f)
      if (lower === q || base === q) {
        groups[0].push(f)
      } else if (base.startsWith(q) || lower.startsWith(q)) {
        groups[1].push(f)
      }
    }
    if (groups[0].length + groups[1].length < limit) {
      for (const f of files) {
        const lower = lowerOf(f)
        const base = baseOf(f)
        if (lower === q || base === q || base.startsWith(q) || lower.startsWith(q)) continue
        if (base.includes(q) || lower.includes(q)) groups[2].push(f)
      }
    }
  }
  for (const g of groups) {
    if (out.length >= limit) break
    // 组内排序：rank 升序；rank 0 组内 mtime 降序（相等/缺失回退字母序）；其余字母序
    const cmp = (a, b) => {
      const ra = rankOf(a)
      const rb = rankOf(b)
      if (ra !== rb) return ra - rb
      if (ra === 0) {
        const ma = topDirty?.get(a) ?? 0
        const mb = topDirty?.get(b) ?? 0
        if (ma !== mb) return mb - ma
      }
      return a < b ? -1 : a > b ? 1 : 0
    }
    const need = limit - out.length
    // top-k 部分排序：大组（数万项）只需前 need 个，避免全量 sort
    const picked = topK(g, need, cmp)
    for (let i = 0; i < picked.length; i++) out.push(picked[i])
  }
  return out
}

/**
 * 将嵌套目录 `.aiinclude` 的规则行展平为「根相对」规则行，以便与根规则
 * 合并成一个规则集（last-match-wins 天然实现层级覆盖：后读入的嵌套规则优先）。
 *
 * 语义对齐 gitignore：目录 D 下的规则相对 D 生效——
 *   - 斜杠模式（`/x`、`x/y`、`x/`）：直接加 D 前缀；
 *   - basename 文件模式（`x`）：展开为 `D/x`（直接子级）与 `D/**` 跨段形式（任意深度）；
 *   - basename 目录模式（`x/`）：展开为 `D/x/` 与 `D/**` 跨段形式；
 *   - `**` 前缀模式（如 `**` + `/x`）：额外补 `D/x`（gitignore 语义：匹配 D 本身及其下任意深度）；
 *   - 取反 `!` 前缀保留，按行序参与 last-match-wins。
 *
 * @param {string} dir 嵌套文件所在目录（根相对，无首尾斜杠，如 `doc/sub`）
 * @param {string[]} lines 该 .aiinclude 的原始行
 * @returns {string[]} 展平后的规则行
 */
export function flattenNestedRules(dir, lines) {
  const out = []
  for (let raw of lines) {
    raw = raw.trim()
    if (raw === '' || raw.startsWith('#')) continue
    let negate = ''
    if (raw.startsWith('!')) {
      negate = '!'
      raw = raw.slice(1).trim()
    }
    if (raw === '') continue
    const dirOnly = raw.endsWith('/')
    if (dirOnly) raw = raw.slice(0, -1)
    const anchored = raw.startsWith('/')
    if (anchored) raw = raw.slice(1)
    if (raw === '') continue
    const base = dir + '/' + raw
    if (anchored || raw.includes('/')) {
      out.push(negate + base + (dirOnly ? '/' : ''))
      if (raw.startsWith('**/')) {
        out.push(negate + dir + '/' + raw.slice(3) + (dirOnly ? '/' : ''))
      }
    } else if (dirOnly) {
      out.push(negate + base + '/')
      out.push(negate + dir + '/**/' + raw + '/')
    } else {
      out.push(negate + base)
      out.push(negate + dir + '/**/' + raw)
    }
  }
  return out
}
