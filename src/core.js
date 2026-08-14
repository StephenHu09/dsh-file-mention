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
      const src = raw
        .split('/')
        .map((seg) => (seg === '**' ? '(?:.*)' : segmentToRegex(seg)))
        .join('/')
      rules.push({ negate, dirOnly, anchored, hasSlash, re: new RegExp('^' + src + '$') })
    } catch {
      // 非法模式跳过
    }
  }
  return rules
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
 * 按查询词过滤文件列表：匹配 basename 或完整路径（大小写不敏感）。
 * 客户端 @ 菜单的过滤逻辑，独立出来以便测试。
 */
export function filterFiles(files, query, limit = 50) {
  const q = String(query || '').trim().toLowerCase()
  let matches = files
  if (q !== '') {
    matches = files.filter((f) => {
      const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
      return base.includes(q) || f.toLowerCase().includes(q)
    })
  }
  return matches.slice(0, limit)
}
