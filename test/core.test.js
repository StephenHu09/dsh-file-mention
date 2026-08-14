/**
 * dsh-file-mention 核心匹配器单元测试（node:test，零依赖）
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileRules, matchRules, filterFiles, dirMayLeadToMatch, parseStatusZ } from '../src/core.js'

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

test('parseStatusZ：普通变更/删除/未跟踪', () => {
  const text = ' M app/src/Main.kt\u0000M  app/build.gradle\u0000D  app/old.java\u0000?? .codebuddy/plans/x.md\u0000'
  assert.deepEqual(parseStatusZ(text), [
    'app/src/Main.kt',
    'app/build.gradle',
    'app/old.java',
    '.codebuddy/plans/x.md',
  ])
})

test('parseStatusZ：重命名取新路径（含路径带空格）', () => {
  const text = 'R  app/old.kt\u0000app/new file.kt\u0000'
  assert.deepEqual(parseStatusZ(text), ['app/new file.kt'])
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
