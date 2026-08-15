/**
 * dsh-file-mention 核心匹配器单元测试（node:test，零依赖）
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileRules, matchRules, filterFiles, dirMayLeadToMatch, parseStatusZ, flattenNestedRules,
  stripRepoPrefix, fileIcon, deriveDirs, visibleDirs, TOP_DIRTY,
} from '../src/core.js'

test('compileRules 忽略注释与空行', () => {
  const rules = compileRules(['', '  ', '# comment', '*.log', ''])
  assert.equal(rules.length, 1)
})

test('basename 模式匹配任意层级', () => {
  const rules = compileRules(['*.log'])
  assert.equal(matchRules(rules, 'app.log', false), true)
  assert.equal(matchRules(rules, 'logs/debug/app.log', false), true)
  assert.equal(matchRules(rules, 'src/main.java', false), false)
})

test('锚定模式（/ 前缀）只匹配基准目录下', () => {
  const rules = compileRules(['/build'])
  assert.equal(matchRules(rules, 'build', true), true)
  assert.equal(matchRules(rules, 'app/build', true), false)
})

test('含斜杠模式按完整相对路径匹配', () => {
  const rules = compileRules(['app/build/generated/**'])
  assert.equal(matchRules(rules, 'app/build/generated/source/x.java', false), true)
  assert.equal(matchRules(rules, 'app/src/main/AndroidManifest.xml', false), false)
})

test('** 跨段匹配', () => {
  const rules = compileRules(['.superpowers/sdd/**'])
  assert.equal(matchRules(rules, '.superpowers/sdd/20260814/progress.md', false), true)
  assert.equal(matchRules(rules, '.superpowers/other/x.md', false), false)
})

test('目录规则（/ 后缀）只对目录生效；basename 规则匹配任意层级目录', () => {
  const rules = compileRules(['build/'])
  assert.equal(matchRules(rules, 'build', true), true)
  assert.equal(matchRules(rules, 'build', false), false)
  // gitignore 语义：无斜杠模式匹配任意层级的同名目录
  assert.equal(matchRules(rules, 'app/build', true), true)
  // 文件不受目录规则影响
  assert.equal(matchRules(rules, 'app/build/output.txt', false), false)
})

test('否定规则：最后匹配者生效（继承排除由 walk 层处理）', () => {
  const rules = compileRules(['doc/', '!doc/private/'])
  assert.equal(matchRules(rules, 'doc', true), true)
  assert.equal(matchRules(rules, 'doc/private', true), false)
  // 匹配器是路径级判定；doc/ 下子级的纳入由 walk 的继承逻辑完成，
  // 而 !doc/private/ 会在 walk 层阻断对该目录的继承
  assert.equal(matchRules(rules, 'doc/public', true), false)
  assert.equal(matchRules(rules, 'doc/private/x.md', false), false)
})

test('? 单字符通配', () => {
  const rules = compileRules(['file?.txt'])
  assert.equal(matchRules(rules, 'file1.txt', false), true)
  assert.equal(matchRules(rules, 'file10.txt', false), false)
})

test('未闭合字符类被转义为字面量，不抛错', () => {
  // '[' 按字面量转义，模式可编译且按字面匹配
  const rules = compileRules(['[unclosed'])
  assert.equal(rules.length, 1)
  assert.equal(matchRules(rules, '[unclosed', false), true)
  assert.equal(matchRules(rules, 'xunclosed', false), false)
})

test('filterFiles 按 basename 与路径过滤', () => {
  const files = ['app/src/MainActivity.kt', 'app/build.gradle', 'doc/计划.md', 'README.md']
  assert.deepEqual(filterFiles(files, 'main'), ['app/src/MainActivity.kt'])
  assert.deepEqual(filterFiles(files, 'gradle'), ['app/build.gradle'])
  assert.deepEqual(filterFiles(files, 'doc/'), ['doc/计划.md'])
  assert.deepEqual(filterFiles(files, 'README'), ['README.md'])
})

test('filterFiles 大小写不敏感', () => {
  const files = ['App/SealActivity.java']
  assert.deepEqual(filterFiles(files, 'sealactivity'), ['App/SealActivity.java'])
})

test('filterFiles 空查询：非隐藏目录优先，组内按码位字母序', () => {
  const files = ['zzz.md', '.agents/skills/a.md', 'app/Main.kt', '.codebuddy/plans/b.md', 'doc/计划.md']
  assert.deepEqual(filterFiles(files, ''), [
    'app/Main.kt',
    'doc/计划.md',
    'zzz.md',
    '.agents/skills/a.md',
    '.codebuddy/plans/b.md',
  ])
})

test('filterFiles 空查询默认返回前 100 项', () => {
  const files = Array.from({ length: 150 }, (_, i) => `f${i}.kt`)
  assert.equal(filterFiles(files, '').length, 100)
})

test('filterFiles 空查询返回前 limit 项', () => {
  const files = Array.from({ length: 100 }, (_, i) => `f${i}.kt`)
  assert.equal(filterFiles(files, '', 50).length, 50)
})

test('parseStatusZ：普通变更/删除/未跟踪（含状态码归一化）', () => {
  const text = ' M app/src/Main.kt\u0000M  app/build.gradle\u0000D  app/old.java\u0000?? .codebuddy/plans/x.md\u0000'
  assert.deepEqual(parseStatusZ(text), [
    { path: 'app/src/Main.kt', status: 'M' },
    { path: 'app/build.gradle', status: 'M' },
    { path: 'app/old.java', status: 'D' },
    { path: '.codebuddy/plans/x.md', status: 'A' },
  ])
})

test('parseStatusZ：重命名取新路径且原路径标记为 D（真实 git -z 格式：R  NEW\0OLD\0，新路径在前）', () => {
  const text = 'R  app/new file.kt\u0000app/old.kt\u0000'
  assert.deepEqual(parseStatusZ(text), [
    { path: 'app/new file.kt', status: 'R' },
    { path: 'app/old.kt', status: 'D' },
  ])
})

test('parseStatusZ：重命名原路径标记为 D，后随普通条目不受影响', () => {
  const text = 'R  b.txt\u0000a.txt\u0000 M c.txt\u0000C  d.txt\u0000e.txt\u0000?? f.txt\u0000'
  // R/C 取新路径并把原路径字段标记为 D；` M`、`??` 按普通条目解析
  assert.deepEqual(parseStatusZ(text), [
    { path: 'b.txt', status: 'R' },
    { path: 'a.txt', status: 'D' },
    { path: 'c.txt', status: 'M' },
    { path: 'd.txt', status: 'R' },
    { path: 'e.txt', status: 'D' },
    { path: 'f.txt', status: 'A' },
  ])
})

test('parseStatusZ：R 条目在末尾（无原路径字段）不越界', () => {
  // 真实 git 总会输出原路径字段，此处验证解析器的防御性
  assert.deepEqual(parseStatusZ('R  new.txt\u0000'), [{ path: 'new.txt', status: 'R' }])
})

test('parseStatusZ：R 条目空路径时跳过但原路径字段仍标记为 D', () => {
  assert.deepEqual(parseStatusZ('R  \u0000old.txt\u0000'), [{ path: 'old.txt', status: 'D' }])
})

test('parseStatusZ：重命名原路径输出 D（同内容 git rm 被配对成 R 源时不丢失删除状态）', () => {
  // 实测：git rm del1.txt + git mv old.txt newname.txt（同内容）→ git 把 del1 配对成
  // rename 源（`R  newname.txt\0del1.txt\0`），del1 的独立 D 条目消失——原路径字段兜底
  const text = 'R  newname.txt\u0000del1.txt\u0000D  old.txt\u0000'
  assert.deepEqual(parseStatusZ(text), [
    { path: 'newname.txt', status: 'R' },
    { path: 'del1.txt', status: 'D' },
    { path: 'old.txt', status: 'D' },
  ])
})

test('parseStatusZ：冲突条目（UU）归一化为 M', () => {
  assert.deepEqual(parseStatusZ('UU app/conflict.js\u0000'), [
    { path: 'app/conflict.js', status: 'M' },
  ])
})

test('stripRepoPrefix：空前缀原样返回', () => {
  assert.deepEqual(stripRepoPrefix(['a.txt', 'sub/b.txt'], ''), ['a.txt', 'sub/b.txt'])
})

test('stripRepoPrefix：裁剪 cwd 前缀并丢弃 cwd 外路径', () => {
  // git status 在子目录输出仓库根相对路径（如 sub/ 下看到 root.txt、sub/x.txt）
  assert.deepEqual(stripRepoPrefix(['root.txt', 'sub/inner.txt', 'sub/sub2/x.txt'], 'sub/'), [
    'inner.txt',
    'sub2/x.txt',
  ])
})

test('stripRepoPrefix：支持结构化条目 { path, status }', () => {
  const items = [
    { path: 'sub/inner.txt', status: 'M' },
    { path: 'root.txt', status: 'M' },
    { path: 'sub/sub2/x.txt', status: 'A' },
  ]
  assert.deepEqual(stripRepoPrefix(items, 'sub/'), [
    { path: 'inner.txt', status: 'M' },
    { path: 'sub2/x.txt', status: 'A' },
  ])
})

test('fileIcon：4 类扩展名映射，未知归其他', () => {
  assert.equal(fileIcon('src/client.js'), '⌨️')
  assert.equal(fileIcon('src/a.tsx'), '⌨️')
  assert.equal(fileIcon('README.md'), '📝')
  assert.equal(fileIcon('docs/images/a.PNG'), '🖼️') // 大小写不敏感
  assert.equal(fileIcon('package.json'), '📄')
  assert.equal(fileIcon('data.sqlite'), '📄')
  assert.equal(fileIcon('.env.example'), '📄') // 隐藏文件
})

test('filterFiles：未提交变更优先，其次非隐藏，最后隐藏', () => {
  const files = [
    'app/BaseActivity.kt',
    '.agents/skills/a.md',
    'doc/计划.md',
    'app/src/MainActivity.kt',
    'README.md',
  ]
  const dirty = new Set(['doc/计划.md', 'app/src/MainActivity.kt'])
  // rank 内按码位字母序：'R'(README) < 'a'(app)
  assert.deepEqual(filterFiles(files, '', 100, dirty), [
    'app/src/MainActivity.kt',
    'doc/计划.md',
    'README.md',
    'app/BaseActivity.kt',
    '.agents/skills/a.md',
  ])
})

test('filterFiles：输入查询词时命中项也按变更优先', () => {
  const files = ['app/SealActivity.java', 'app/StampActivity.java', 'doc/计划.md']
  const dirty = new Set(['app/StampActivity.java'])
  assert.deepEqual(filterFiles(files, 'activity', 100, dirty), [
    'app/StampActivity.java',
    'app/SealActivity.java',
  ])
})

test('filterFiles：无 dirty 时保持非隐藏优先（A 方案回归）', () => {
  const files = ['zzz.md', '.agents/skills/a.md', 'app/Main.kt', 'doc/计划.md']
  assert.deepEqual(filterFiles(files, ''), ['app/Main.kt', 'doc/计划.md', 'zzz.md', '.agents/skills/a.md'])
})

test('filterFiles：精确匹配（路径或 basename）排最前', () => {
  const files = ['app/MainActivity.kt', 'app/MainActivityHelper.kt', 'app/MyMainActivity.kt']
  // 完整路径精确 → 唯一命中
  assert.deepEqual(filterFiles(files, 'app/MainActivity.kt'), ['app/MainActivity.kt'])
  // basename 精确（score 0）优先于子串（score 2）；Helper 不含 .kt 子串被过滤
  assert.deepEqual(filterFiles(files, 'MainActivity.kt'), [
    'app/MainActivity.kt',
    'app/MyMainActivity.kt',
  ])
})

test('filterFiles：相关性优先于 dirty（精确非变更 > 子串变更）', () => {
  const files = ['app/MyActivity.java', 'app/Activity.java', 'app/AnotherActivity.java']
  const dirty = new Set(['app/MyActivity.java'])
  assert.deepEqual(filterFiles(files, 'Activity.java', 100, dirty), [
    'app/Activity.java', // 精确 basename（score 0，非 dirty）
    'app/MyActivity.java', // 子串（score 2）但 dirty
    'app/AnotherActivity.java', // 子串（score 2）
  ])
})

test('filterFiles：前缀匹配排在子串前', () => {
  const files = ['doc/MainActivity.txt', 'app/MainActivityHelper.kt', 'app/MyMainActivity.kt', 'doc/main.md']
  assert.deepEqual(filterFiles(files, 'main'), [
    'app/MainActivityHelper.kt', // 前缀，组内码位序：'a' < 'd'
    'doc/MainActivity.txt',
    'doc/main.md', // 'M'(0x4D) < 'm'(0x6D)
    'app/MyMainActivity.kt', // 子串最后
  ])
})

test('deriveDirs：从文件列表派生全部父目录（去重、排序、尾斜杠）', () => {
  assert.deepEqual(deriveDirs(['docs/images/example.png', 'docs/architecture.md', 'src/core.js', 'README.md']), [
    'docs/',
    'docs/images/',
    'src/',
  ])
  assert.deepEqual(deriveDirs(['a.txt']), []) // 根目录文件 → 无目录
  assert.deepEqual(deriveDirs([]), [])
  assert.deepEqual(deriveDirs(['sub/deep/leaf.js', 'sub/other.js', 'sub/deep/leaf2.js']), ['sub/', 'sub/deep/'])
})

test('visibleDirs：目录逐级展开（深度 = 查询词 / 数量 + 1）', () => {
  const dirs = ['app/', 'app/src/', 'app/src/main/', 'docs/', 'docs/images/', 'lib/']
  // 无斜杠/空查询：只显示顶层（第一层）
  assert.deepEqual(visibleDirs(dirs, ''), ['app/', 'docs/', 'lib/'])
  assert.deepEqual(visibleDirs(dirs, 'app'), ['app/', 'docs/', 'lib/'])
  // 进入 app（尾斜杠）：深度 2——app/ 直接子目录放行，第三层 app/src/main/ 不显示
  assert.deepEqual(visibleDirs(dirs, 'app/'), ['app/', 'app/src/', 'docs/', 'docs/images/', 'lib/'])
  // 无尾斜杠但含斜杠：同样深度 2
  assert.deepEqual(visibleDirs(dirs, 'app/src'), ['app/', 'app/src/', 'docs/', 'docs/images/', 'lib/'])
  // 进入 app/src：深度 3
  assert.deepEqual(visibleDirs(dirs, 'app/src/'), dirs)
})

test('visibleDirs：单段查询直达深层目录（basename 前缀匹配突破深度）', () => {
  const dirs = ['docs/', 'docs/10_logcat_analyze/', 'docs/10_logcat_analyze/logs/', 'docs/images/', 'app/', 'app/src/']
  // @10_logcat_analyze：docs/10_logcat_analyze/ 放行（basename 前缀匹配），
  // 其他深层目录（logs/、images/、src/）不放行；顶层目录照常
  assert.deepEqual(visibleDirs(dirs, '10_logcat_analyze'), [
    'docs/',
    'docs/10_logcat_analyze/',
    'app/',
  ])
  // 前缀匹配：@10_log 也直达
  assert.deepEqual(visibleDirs(dirs, '10_log'), ['docs/', 'docs/10_logcat_analyze/', 'app/'])
  // 非前缀子串（logcat）不放行（startsWith 而非 includes）
  assert.deepEqual(visibleDirs(dirs, 'logcat'), ['docs/', 'app/'])
  // 短查询词不会放行大量无关目录
  assert.deepEqual(visibleDirs(dirs, 'a'), ['docs/', 'app/'])
})

test('visibleDirs + filterFiles：@10_logcat_analyze 目录显示且排在文件前', () => {
  const dirs = visibleDirs(['docs/', 'docs/10_logcat_analyze/', 'docs/images/'], '10_logcat_analyze')
  const files = ['docs/10_logcat_analyze/readme.md', 'docs/10_logcat_analyze/logs/2026-01.txt', 'README.md']
  assert.deepEqual(filterFiles([...dirs, ...files], '10_logcat_analyze', 100), [
    'docs/10_logcat_analyze/', // 目录 rank 1 在前
    'docs/10_logcat_analyze/logs/2026-01.txt',
    'docs/10_logcat_analyze/readme.md',
  ])
})

test('visibleDirs + filterFiles：@app/ 逐级展开只显示第二层（不显示更深子目录）', () => {
  const dirs = visibleDirs(['app/', 'app/src/', 'app/src/main/', 'app/src/main/java/', 'docs/'], 'app/')
  const files = ['app/src/main/java/com/x/MainActivity.kt', 'app/build.gradle', 'docs/architecture.md']
  assert.deepEqual(filterFiles([...dirs, ...files], 'app/', 100), [
    'app/', // 第一层（路径含 app/）
    'app/src/', // 第二层 ✓
    // 第三层 app/src/main/、app/src/main/java/ 已被 visibleDirs 挡掉
    'app/build.gradle',
    'app/src/main/java/com/x/MainActivity.kt',
  ])
})

test('filterFiles：目录项参与过滤与排序（尾斜杠 basename 正确提取）', () => {
  const items = ['docs/', 'docs/architecture.md', 'src/', 'src/core.js', '.agents/', 'README.md']
  // 目录 `docs/` basename = docs：前缀命中排前；同 score 下字母序 `docs/` < `docs/architecture.md`
  assert.deepEqual(filterFiles(items, 'docs'), ['docs/', 'docs/architecture.md'])
  // 空查询：目录（rank 1）集中置前 → 普通文件（rank 2）→ 隐藏（rank 3）
  assert.deepEqual(filterFiles(items, ''), [
    'docs/',
    'src/',
    'README.md',
    'docs/architecture.md',
    'src/core.js',
    '.agents/',
  ])
})

test('filterFiles：目录集中置前（变更文件 > 目录 > 普通文件 > 隐藏）', () => {
  const items = ['zzz.txt', '.hidden/', '.env', 'aaa/', 'docs/', 'app/Main.kt']
  const dirty = new Set(['zzz.txt'])
  assert.deepEqual(filterFiles(items, '', 100, dirty), [
    'zzz.txt', // rank 0 变更
    'aaa/', // rank 1 目录（字母序）
    'docs/',
    'app/Main.kt', // rank 2 普通文件
    '.env', // rank 3 隐藏文件
    '.hidden/', // rank 3 隐藏目录
  ])
})

test('filterFiles：dirty 数组含 mtime 时只置顶最近修改的 TOP_DIRTY 个（其余回落 rank 2）', () => {
  const items = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt', 'f7.txt', 'docs/', 'aaa.txt']
  const dirty = [
    { path: 'f1.txt', mtime: 100 },
    { path: 'f2.txt', mtime: 200 },
    { path: 'f3.txt', mtime: 300 },
    { path: 'f4.txt', mtime: 400 },
    { path: 'f5.txt', mtime: 500 },
    { path: 'f6.txt', mtime: 600 },
    { path: 'f7.txt', mtime: 700 },
  ]
  // TOP_DIRTY=5：mtime 最大 5 个（f7..f3）置顶（mtime 降序），其余变更（f2/f1）回落 rank 2 与普通文件混排
  assert.deepEqual(filterFiles(items, '', 100, dirty), [
    'f7.txt', 'f6.txt', 'f5.txt', 'f4.txt', 'f3.txt',
    'docs/',
    'aaa.txt', 'f1.txt', 'f2.txt',
  ])
  assert.equal(TOP_DIRTY, 5)
})

test('filterFiles：dirty 数组无 mtime（旧版 Host）回退全量置顶', () => {
  const items = ['f1.txt', 'f2.txt', 'docs/']
  assert.deepEqual(filterFiles(items, '', 100, [{ path: 'f1.txt' }, { path: 'f2.txt' }]), [
    'f1.txt',
    'f2.txt',
    'docs/',
  ])
  // string[] 旧格式同样全量置顶
  assert.deepEqual(filterFiles(items, '', 100, ['f1.txt']), ['f1.txt', 'docs/', 'f2.txt'])
})

test('filterFiles：dirty 不影响目录（目录不在变更集，仍 rank 1）', () => {
  const items = ['docs/', 'docs/architecture.md', 'src/', 'src/core.js']
  const dirty = new Set(['docs/architecture.md', 'src/core.js'])
  assert.deepEqual(filterFiles(items, '', 100, dirty), [
    'docs/architecture.md',
    'src/core.js',
    'docs/',
    'src/',
  ])
})

test('回归矩阵：空查询完整排序快照（TOP_DIRTY + 目录 + 剩余变更 + 隐藏）', () => {
  // 规则快照：变更(按 mtime 降序取前 5) → 目录(字母序) → 剩余变更+普通文件(字母序) → 隐藏。
  // 未来调整任一规则（TOP_DIRTY 数量/rank/目录深度）此处应立即变红。
  const items = [
    'app/', 'app/src/', 'docs/', 'docs/images/',
    'a.txt', 'b.txt', 'c.txt', 'zzz.txt', '.env', '.hidden/', 'README.md',
  ]
  const dirty = [
    { path: 'a.txt', mtime: 100 },
    { path: 'zzz.txt', mtime: 900 },
    { path: 'c.txt', mtime: 300 },
    { path: 'b.txt', mtime: 500 },
  ]
  assert.deepEqual(filterFiles(items, '', 100, dirty), [
    'zzz.txt', // mtime 900
    'b.txt', // 500
    'c.txt', // 300
    'a.txt', // 100（4 个变更全置顶，未超 TOP_DIRTY）
    'app/', // 目录 rank 1，字母序
    'app/src/',
    'docs/',
    'docs/images/',
    'README.md', // rank 2 普通文件
    '.env', // rank 3 隐藏文件
    '.hidden/', // rank 3 隐藏目录
  ])
})

test('回归矩阵：查询词下 score/rank/mtime 叠加快照', () => {
  // score 优先于 rank：同 score 组内按 rank；rank 0 组内按 mtime。
  const items = ['app/', 'app/src/', 'a.txt', 'ab.txt', 'b.txt', 'docs/']
  const dirty = [
    { path: 'ab.txt', mtime: 100 }, // 旧
    { path: 'b.txt', mtime: 900 }, // 新
  ]
  // 'a'：全部前缀命中（score 1，a.txt 的 basename 是 'a.txt' 非精确）→
  // rank 0 变更(ab.txt) 在 rank 1 目录(app/)前；a.txt rank 2 最后
  assert.deepEqual(filterFiles(items, 'a', 100, dirty), [
    'ab.txt',
    'app/',
    'app/src/',
    'a.txt',
  ])
  // 'b'：b.txt 精确(0)；ab.txt 子串(2)
  assert.deepEqual(filterFiles(items, 'b', 100, dirty), ['b.txt', 'ab.txt'])
})

test('flattenNestedRules：basename 规则展开为直接子级 + 任意深度', () => {
  assert.deepEqual(flattenNestedRules('doc', ['*.log']), ['doc/*.log', 'doc/**/*.log'])
  assert.deepEqual(flattenNestedRules('doc', ['!secret.md']), ['!doc/secret.md', '!doc/**/secret.md'])
})

test('flattenNestedRules：目录/锚定/斜杠模式加前缀；忽略注释空行', () => {
  assert.deepEqual(flattenNestedRules('doc', ['build/']), ['doc/build/', 'doc/**/build/'])
  assert.deepEqual(flattenNestedRules('doc', ['/build']), ['doc/build'])
  assert.deepEqual(flattenNestedRules('doc', ['sub/build/**']), ['doc/sub/build/**'])
  assert.deepEqual(flattenNestedRules('doc/sub', ['**/x.md']), ['doc/sub/**/x.md', 'doc/sub/x.md'])
  assert.deepEqual(flattenNestedRules('doc', ['', '# c', '  ']), [])
})

test('嵌套规则合并：展平后与根规则 last-match-wins（嵌套覆盖根，否定生效）', () => {
  const rules = compileRules(['doc/', ...flattenNestedRules('doc', ['!private/'])])
  assert.equal(matchRules(rules, 'doc', true), true)
  // 嵌套 !private/ 在规则集尾部，覆盖根 doc/ 的继承（walk 层阻断）
  assert.equal(matchRules(rules, 'doc/private', true), false)
  assert.equal(matchRules(rules, 'doc/public', true), false)
})

test('嵌套展平规则可剪枝且按深度匹配（D/**/x 前缀放行 D 下目录）', () => {
  const rules = compileRules(flattenNestedRules('doc', ['*.md']))
  assert.equal(dirMayLeadToMatch(rules, 'doc'), true)
  assert.equal(dirMayLeadToMatch(rules, 'doc/sub'), true)
  assert.equal(dirMayLeadToMatch(rules, 'app'), false)
  assert.equal(matchRules(rules, 'doc/sub/a.md', false), true)
  assert.equal(matchRules(rules, 'doc/sub/a.kt', false), false)
  assert.equal(matchRules(rules, 'app/a.md', false), false)
})

test('dirMayLeadToMatch：basename 目录规则只放行同名目录', () => {
  const rules = compileRules(['doc/'])
  assert.equal(dirMayLeadToMatch(rules, 'doc'), true)
  // 子目录的纳入由 doc 命中后的继承完成，剪枝判定层面自身不匹配
  assert.equal(dirMayLeadToMatch(rules, 'doc/07_project_review讨论'), false)
  assert.equal(dirMayLeadToMatch(rules, 'app'), false)
  assert.equal(dirMayLeadToMatch(rules, 'app/src'), false)
})

test('dirMayLeadToMatch：basename 文件规则不可剪枝', () => {
  const rules = compileRules(['*.log'])
  assert.equal(dirMayLeadToMatch(rules, 'app'), true)
  assert.equal(dirMayLeadToMatch(rules, 'app/src/deep'), true)
})

test('dirMayLeadToMatch：斜杠规则按段前缀放行', () => {
  const rules = compileRules(['app/build/generated/**'])
  assert.equal(dirMayLeadToMatch(rules, 'app'), true)
  assert.equal(dirMayLeadToMatch(rules, 'app/build'), true)
  assert.equal(dirMayLeadToMatch(rules, 'app/build/generated'), true)
  assert.equal(dirMayLeadToMatch(rules, 'doc'), false)
  assert.equal(dirMayLeadToMatch(rules, 'app/src'), false)
})

test('dirMayLeadToMatch：锚定规则只放行锚定前缀', () => {
  const rules = compileRules(['/build'])
  assert.equal(dirMayLeadToMatch(rules, 'build'), true)
  assert.equal(dirMayLeadToMatch(rules, 'app'), false)
})
