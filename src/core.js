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
 * 解析 `git status --porcelain -z` 输出为变更文件路径列表。
 * 每条 `<XY> <path>\0`；重命名/复制（R/C）占两个字段，取新路径。
 * 路径含空格等特殊字符时依然精确（-z 不做引号转义）。
 */
export function parseStatusZ(text) {
  const dirty = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry === '') continue
    const code = entry[0]
    if ((code === 'R' || code === 'C') && i + 1 < parts.length) {
      i += 1
      dirty.push(parts[i])
    } else {
      const path = entry.slice(3)
      if (path !== '') dirty.push(path)
    }
  }
  return dirty
}

/**
 * 按查询词过滤文件列表：匹配 basename 或完整路径（大小写不敏感）。
 * 客户端 @ 菜单的过滤逻辑，独立出来以便测试。
 *
 * 默认排序规则（空查询与命中项都适用，rank 升序 + 组内字母序）：
 *   0. git 未提交变更（dirty 集合内）
 *   1. 非隐藏目录（首段不以 . 开头）
 *   2. 隐藏目录
 */
export function filterFiles(files, query, limit = 100, dirty) {
  const q = String(query || '').trim().toLowerCase()
  const dirtySet = dirty instanceof Set ? dirty : undefined
  const rank = (f) => {
    if (dirtySet !== undefined && dirtySet.has(f)) return 0
    if (f.split('/')[0].startsWith('.')) return 2
    return 1
  }
  let matches = files
  if (q !== '') {
    matches = files.filter((f) => {
      const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
      return base.includes(q) || f.toLowerCase().includes(q)
    })
  }
  if (dirtySet !== undefined || q === '') {
    matches = [...matches].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  }
  return matches.slice(0, limit)
}
