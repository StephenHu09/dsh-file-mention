/**
 * dsh-file-mention —— Host 集成测试（模拟正常代码开发场景）
 *
 * 每个用例在系统临时目录创建独立 git 仓库，通过最小 ctx mock 加载
 * src/host.js 的 apply()（subprocess 走**真实 git**、fs 走**真实文件系统**），
 * 直调 /file-mention/list handler 断言 files/dirty 行为。
 *
 * 场景矩阵：文件生命周期（新建/修改/重命名/删除/恢复）× 路径（中文/空格/
 * 子目录）× 配置（.gitignore/.aiinclude/回退模式）× 缓存时效。
 *
 * 运行：npm run test:it（node --test test/host.integration.test.js）
 * 依赖：真实 git 可执行（Windows/Linux 均可），无第三方 npm 依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/host.js'

/** 真实文件系统适配（模拟 dsh 的 fs 服务接口）。 */
const realFs = {
  resolve: (p) => Promise.resolve(p),
  stat: async (p) => {
    try {
      const s = await fsp.stat(p)
      return { type: s.isDirectory() ? 'directory' : 'file' }
    } catch {
      return undefined // 不存在 → undefined（与生产 fs 服务一致）
    }
  },
  readText: (p) => fsp.readFile(p, 'utf8'),
  listDir: async (p) => {
    const ents = await fsp.readdir(p, { withFileTypes: true })
    return ents.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      target: join(p, e.name),
    }))
  },
}

/** 真实 git 执行：返回 stdout（trim）。 */
function runGit(repo, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: repo })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', () => resolve(out.trim()))
  })
}

async function initRepo(repo) {
  await runGit(repo, ['init', '-q'])
  await runGit(repo, ['config', 'user.email', 't@t'])
  await runGit(repo, ['config', 'user.name', 't'])
}

async function commitAll(repo, message = 'init') {
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['commit', '-qm', message])
}

/** 建临时仓库；t.after 自动清理。 */
function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'fm-it-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  return repo
}

/** 在仓库内建文件（自动建父目录）。 */
function putFile(repo, rel, content = 'x') {
  const p = join(repo, ...rel.split('/'))
  mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(p, content)
}

/**
 * 创建插件应用实例：每个用例独立实例 → 独立缓存，免跨用例串扰。
 * 返回 { call(cwdOverride) } 直调 handler。
 */
function createApp(sessionCwd, fsImpl = realFs) {
  let handler
  const ctx = {
    get(name) {
      if (name === 'fs') return fsImpl
      if (name === 'subprocess') {
        return {
          spawn({ argv, cwd }) {
            const child = spawn(argv[0], argv.slice(1), { cwd })
            let out = ''
            let err = ''
            child.stdout.on('data', (d) => (out += d))
            child.stderr.on('data', (d) => (err += d))
            return {
              done: new Promise((resolve) =>
                child.on('close', (code) => resolve({ exitCode: code })),
              ),
              collected: {
                stdout: { readFrom: () => ({ text: out }) },
                stderr: { readFrom: () => ({ text: err }) },
              },
            }
          },
        }
      }
      return undefined
    },
    sessions: { get: () => ({ header: { cwd: sessionCwd } }) },
    effect: (fn) => fn(),
    webServer: { register({ handler: h }) { handler = h } },
  }
  apply(ctx)
  return {
    async call(cwd = sessionCwd) {
      ctx.sessions.get = () => ({ header: { cwd } })
      const body = Buffer.from(JSON.stringify({ sessionId: 'it' }))
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        [Symbol.asyncIterator]() {
          let sent = false
          return {
            next: async () =>
              sent ? { done: true } : ((sent = true), { done: false, value: body }),
          }
        },
      }
      let resp
      const res = { writeHead: () => {}, end: (t) => (resp = JSON.parse(t)) }
      await handler(req, res)
      return resp
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** dirty 为 [{ path, status }]，断言路径存在性/状态码。 */
const hasPath = (dirty, p) => dirty.some((d) => d.path === p)
const statusOf = (dirty, p) => (dirty.find((d) => d.path === p) || {}).status

// ============ 文件生命周期 ============

test('新建文件（新目录）：无需 git add 即可 @ 引用，且按未提交变更置顶', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  await commitAll(repo)
  putFile(repo, 'docs/images/new.png')

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('docs/images/new.png'), `files 应含 docs/images/new.png，实际: ${files.join(',')}`)
  assert.ok(hasPath(dirty, 'docs/images/new.png'), 'dirty 应含新建文件（变更优先）')
  assert.equal(statusOf(dirty, 'docs/images/new.png'), 'A', '新建文件状态码应为 A')
})

test('新建文件（已跟踪目录）：同样入列', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'src/old.js')
  await commitAll(repo)
  putFile(repo, 'src/new.js')

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('src/new.js'))
  assert.ok(hasPath(dirty, 'src/new.js'))
})

test('修改文件（unstaged）：files 与 dirty 均含', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'app/main.js', 'v1')
  await commitAll(repo)
  putFile(repo, 'app/main.js', 'v2')

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('app/main.js'))
  assert.ok(hasPath(dirty, 'app/main.js'))
  assert.equal(statusOf(dirty, 'app/main.js'), 'M', '修改文件状态码应为 M')
})

test('修改文件（staged）：files 与 dirty 均含', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'app/main.js', 'v1')
  await commitAll(repo)
  putFile(repo, 'app/main.js', 'v2')
  await runGit(repo, ['add', 'app/main.js'])

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('app/main.js'))
  assert.ok(hasPath(dirty, 'app/main.js'))
  assert.equal(statusOf(dirty, 'app/main.js'), 'M', 'staged 修改状态码应为 M')
})

test('重命名（git mv staged）：dirty 取新路径、旧路径不残留', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'old.txt')
  await commitAll(repo)
  await runGit(repo, ['mv', 'old.txt', 'new file.txt'])

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('new file.txt'), 'files 应含新路径')
  assert.ok(hasPath(dirty, 'new file.txt'), 'dirty 应含新路径（未提交变更优先）')
  assert.equal(statusOf(dirty, 'new file.txt'), 'R', '重命名状态码应为 R')
  assert.ok(!hasPath(dirty, 'old.txt'), 'dirty 不应含旧路径')
})

test('重命名（工作区 mv unstaged）：新路径入列且可读，旧路径剔除', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'old.txt')
  await commitAll(repo)
  renameSync(join(repo, 'old.txt'), join(repo, 'renamed.txt'))

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('renamed.txt'), 'files 应含新路径（未跟踪合并）')
  assert.ok(!files.includes('old.txt'), 'files 不应含旧路径（工作区已删除）')
  assert.ok(hasPath(dirty, 'renamed.txt'), 'dirty 应含新路径')
  assert.equal(statusOf(dirty, 'renamed.txt'), 'A', '工作区重命名新路径按未跟踪 A 标记')
  assert.ok(!hasPath(dirty, 'old.txt'), 'dirty 不应含已删除的旧路径')
})

test('删除（git rm staged）：不再出现在 files 列表', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'bye.txt')
  await commitAll(repo)
  await runGit(repo, ['rm', '-q', 'bye.txt'])

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(!files.includes('bye.txt'), 'files 不应含已删除文件（index 已移除）')
  // staged delete（`D `）：dirty 保留 { path, status: 'D' } 条目（语义完整的变更记录）；
  // 该路径不在 files，客户端不展示、不影响排序。
  assert.ok(hasPath(dirty, 'bye.txt'), 'dirty 保留 staged 删除记录（D）')
  assert.equal(statusOf(dirty, 'bye.txt'), 'D', '删除状态码应为 D')
})

test('删除（手动 unstaged）：从 files 与 dirty 剔除', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'bye.txt')
  await commitAll(repo)
  rmSync(join(repo, 'bye.txt'))

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(!files.includes('bye.txt'), 'files 不应含已删除文件（ls-files -d 剔除）')
  assert.ok(!hasPath(dirty, 'bye.txt'))
})

// ============ 路径多样性 ============

test('中文与空格文件名：原样入列', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, '计划.md')
  putFile(repo, 'my file.txt')

  const app = createApp(repo)
  const { files } = await app.call()
  assert.ok(files.includes('计划.md'), '中文文件名应原样入列（quotepath=false）')
  assert.ok(files.includes('my file.txt'), '空格文件名应原样入列')
})

test('子目录会话：只列 cwd 下文件，dirty 按 cwd 裁剪（不泄漏仓库外变更）', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'root.txt')
  putFile(repo, 'sub/inner.txt')
  putFile(repo, 'sub/sub2/deep.txt')
  await commitAll(repo)
  putFile(repo, 'root.txt', 'r2') // 仓库根变更（cwd 外，不应出现）
  putFile(repo, 'sub/inner.txt', 'i2') // cwd 内变更

  const app = createApp(join(repo, 'sub'))
  const { files, dirty } = await app.call()
  assert.ok(files.includes('inner.txt'), 'files 应含 cwd 内文件（cwd 相对路径）')
  assert.ok(files.includes('sub2/deep.txt'), 'files 应含 cwd 下多级子目录文件')
  assert.ok(!files.includes('root.txt'), 'files 不应含 cwd 外文件')
  assert.ok(hasPath(dirty, 'inner.txt'), 'dirty 应含 cwd 内修改（--show-prefix 裁剪）')
  assert.ok(!hasPath(dirty, 'root.txt'), 'dirty 不应含 cwd 外变更')
  assert.ok(dirty.every((d) => !d.path.startsWith('sub/')), 'dirty 不应残留仓库根相对前缀')
})

test('子目录会话（大小写变体 cwd）：同样正确', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'sub/keep.txt')
  await commitAll(repo)
  putFile(repo, 'sub/keep.txt', 'k2')

  const upperSub = join(repo, 'SUB').toUpperCase() // Windows 大小写不敏感路径
  const app = createApp(upperSub)
  const { files, dirty } = await app.call()
  assert.deepEqual(files, ['keep.txt'])
  assert.deepEqual(dirty, [{ path: 'keep.txt', status: 'M' }])
})

// ============ 配置与降级 ============

test('.gitignore 忽略的未跟踪文件不入列', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  await commitAll(repo)
  putFile(repo, 'build/out.tmp')
  writeFileSync(join(repo, '.gitignore'), '*.tmp\n')

  const app = createApp(repo)
  const r1 = await app.call()
  assert.ok(!r1.files.includes('build/out.tmp'), '被忽略文件不应入列')
})

test('.gitignore 取消忽略后未跟踪文件入列', async (t) => {
  // 独立仓库独立实例：host 缓存为模块级共享，同一仓库多实例会命中旧缓存
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  await commitAll(repo)
  putFile(repo, 'build/out.tmp')
  writeFileSync(join(repo, '.gitignore'), '# empty\n')

  const app = createApp(repo)
  const r2 = await app.call()
  assert.ok(r2.files.includes('build/out.tmp'), '取消忽略后应入列')
})

test('.aiinclude 把被忽略文件重新纳入 @ 菜单', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  await commitAll(repo)
  putFile(repo, 'secret/data.json')
  writeFileSync(join(repo, '.gitignore'), 'secret/\n')
  writeFileSync(join(repo, '.aiinclude'), 'secret/\n')

  const app = createApp(repo)
  const { files } = await app.call()
  assert.ok(files.includes('secret/data.json'), '.aiinclude 命中的忽略文件应被重新纳入')
})

test('非 git 目录：回退为 .gitignore 解析 + 全量扫描', async (t) => {
  const repo = makeRepo(t) // 不 init git → 非仓库
  putFile(repo, 'plain.txt')
  putFile(repo, 'node_modules/x.js') // SKIP 重型目录
  writeFileSync(join(repo, '.gitignore'), '*.log\n')
  putFile(repo, 'debug.log')

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('plain.txt'), '回退模式应列出普通文件')
  assert.ok(!files.includes('debug.log'), '回退模式应遵守 .gitignore')
  assert.ok(!files.includes('node_modules/x.js'), 'SKIP 重型目录不应遍历')
  assert.deepEqual(dirty, [], '非仓库 dirty 应为空')
})

test('空 git 仓库（仅 init 未提交）：未跟踪文件正常入列', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'first.txt')

  const app = createApp(repo)
  const { files, dirty } = await app.call()
  assert.ok(files.includes('first.txt'))
  assert.ok(hasPath(dirty, 'first.txt'))
})

// ============ 缓存时效与一致性 ============

test('缓存一致性：未跟踪文件删除后 5s 缓存窗口内残留属预期，过期后消失；恢复后重现', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  await commitAll(repo)
  putFile(repo, 'probe.txt')

  const app = createApp(repo)
  const r1 = await app.call()
  assert.ok(r1.files.includes('probe.txt'), '初始应入列')

  rmSync(join(repo, 'probe.txt'))
  const r2 = await app.call() // untracked 缓存(5s)未过期 → 命中旧列表
  assert.ok(r2.files.includes('probe.txt'), '5s 缓存窗口内残留属预期（SWR/TTL 设计）')

  await sleep(5600)
  const r3 = await app.call()
  assert.ok(!r3.files.includes('probe.txt'), '缓存过期后应消失（不残留不存在文件）')

  putFile(repo, 'probe.txt')
  await sleep(5600)
  const r4 = await app.call()
  assert.ok(r4.files.includes('probe.txt'), '恢复后应重现')
})

// ============ 一致性：所有列表项必须物理存在 ============

test('一致性：files 中每一项都必须是磁盘上真实存在的文件', async (t) => {
  const repo = makeRepo(t)
  await initRepo(repo)
  putFile(repo, 'a.txt')
  putFile(repo, 'sub/b.txt')
  await commitAll(repo)
  putFile(repo, 'new/c.txt') // untracked
  rmSync(join(repo, 'sub/b.txt')) // deleted

  const app = createApp(repo)
  const { files } = await app.call()
  for (const f of files) {
    const full = join(repo, ...f.split('/'))
    const st = await fsp.stat(full).catch(() => undefined)
    assert.ok(st !== undefined && st.isFile(), `files 项 ${f} 必须物理存在`)
  }
  assert.ok(files.includes('a.txt'))
  assert.ok(files.includes('new/c.txt'))
  assert.ok(!files.includes('sub/b.txt'))
})
