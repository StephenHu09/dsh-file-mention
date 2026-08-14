/**
 * dsh-file-mention 核心匹配器单元测试（node:test，零依赖）
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileRules, matchRules, filterFiles } from '../src/core.js'

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

test('filterFiles 空查询返回前 limit 项', () => {
  const files = Array.from({ length: 100 }, (_, i) => `f${i}.kt`)
  assert.equal(filterFiles(files, '', 50).length, 50)
})
