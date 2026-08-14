/**
 * dsh-file-mention 核心匹配器单元测试（node:test，零依赖）
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileRules, matchRules, filterFiles, dirMayLeadToMatch, parseStatusZ, flattenNestedRules,
  stripRepoPrefix, fileIcon, statusLetter, stripStatusSuffix,
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

test('parseStatusZ：重命名取新路径（真实 git -z 格式：R  NEW\0OLD\0，新路径在前）', () => {
  const text = 'R  app/new file.kt\u0000app/old.kt\u0000'
  assert.deepEqual(parseStatusZ(text), [{ path: 'app/new file.kt', status: 'R' }])
})

test('parseStatusZ：重命名原路径字段被正确跳过，后随普通条目不受影响', () => {
  const text = 'R  b.txt\u0000a.txt\u0000 M c.txt\u0000C  d.txt\u0000e.txt\u0000?? f.txt\u0000'
  // R/C 取新路径并跳过原路径字段；` M`、`??` 按普通条目解析
  assert.deepEqual(parseStatusZ(text), [
    { path: 'b.txt', status: 'R' },
    { path: 'c.txt', status: 'M' },
    { path: 'd.txt', status: 'R' },
    { path: 'f.txt', status: 'A' },
  ])
})

test('parseStatusZ：R 条目在末尾（无原路径字段）不越界', () => {
  // 真实 git 总会输出原路径字段，此处验证解析器的防御性
  assert.deepEqual(parseStatusZ('R  new.txt\u0000'), [{ path: 'new.txt', status: 'R' }])
})

test('parseStatusZ：R 条目空路径时跳过但原路径字段仍被消费', () => {
  assert.deepEqual(parseStatusZ('R  \u0000old.txt\u0000'), [])
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

test('statusLetter：M/A/D/R 原样，未识别兜底 M', () => {
  assert.equal(statusLetter('M'), 'M')
  assert.equal(statusLetter('A'), 'A')
  assert.equal(statusLetter('D'), 'D')
  assert.equal(statusLetter('R'), 'R')
  assert.equal(statusLetter('X'), 'M')
  assert.equal(statusLetter(undefined), 'M')
})

test('stripStatusSuffix：剥离尾部状态字母，无标记原样返回', () => {
  assert.equal(stripStatusSuffix('src/client.js M'), 'src/client.js')
  assert.equal(stripStatusSuffix('src/client.js A'), 'src/client.js')
  assert.equal(stripStatusSuffix('src/client.js'), 'src/client.js')
  assert.equal(stripStatusSuffix('docs/计划 M'), 'docs/计划')
  assert.equal(stripStatusSuffix('a b.txt'), 'a b.txt')
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
