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
 * 按查询词过滤文件/目录列表：匹配 basename 或完整路径（大小写不敏感）。
 * 客户端 @ 菜单的过滤逻辑，独立出来以便测试。
 *
 * 命中排序（score 升序 + rank 升序 + 组内字母序）：
 *   score 0. 精确匹配（完整路径或 basename 与查询词完全相等）
 *   score 1. 前缀匹配（basename 或完整路径以查询词开头）
 *   score 2. 子串匹配（basename 或完整路径包含查询词）
 *   rank 0. 未提交变更（dirty 集合成员，仅文件）
 *   rank 1. 普通文件与目录
 *   rank 2. 隐藏路径（首段以 `.` 开头）
 */
export function filterFiles(files, query, limit = 100, dirty) {
  const q = String(query || '').trim().toLowerCase()
  const dirtySet = dirty instanceof Set ? dirty : undefined
  const rank = (f) => {
    if (dirtySet !== undefined && dirtySet.has(f)) return 0
    if (f.split('/')[0].startsWith('.')) return 2
    return 1
  }
  const score = (f) => {
    if (q === '') return 0
    const lower = f.toLowerCase()
    const base = baseName(f).toLowerCase()
    if (lower === q || base === q) return 0
    if (base.startsWith(q) || lower.startsWith(q)) return 1
    return 2
  }
  let matches = files
  if (q !== '') {
    matches = files.filter((f) => {
      const base = baseName(f).toLowerCase()
      return base.includes(q) || f.toLowerCase().includes(q)
    })
  }
  // 恒排序：空查询退化为 rank + 字母序（与历史行为一致），有查询词时 score 优先
  matches = [...matches].sort(
    (a, b) => score(a) - score(b) || rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  return matches.slice(0, limit)
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
