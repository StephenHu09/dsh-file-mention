# AGENTS.md —— dsh-file-mention 协作规则

本文档为 AI 编码助手与本仓库维护者（hucj）协作时的工作约定，是本项目规则的**唯一维护来源**。

**文档分工**：
- **README.md / README.en.md** —— 面向**使用者**的教程与说明（安装、卸载、配置、发布指引）
- **AGENTS.md** —— 面向**维护者与 AI 助手**的工作规则（版本、构建、同步、提交约定）

## 项目定位

npm 包 **`@hucj/dsh-file-mention`**：DSH（DeepSeek Harness）Web GUI 的 `@` 文件引用插件。
双端架构：Host 半体（`webServer` HTTP 路由 `/file-mention/list`）+ Client 半体（`inputTriggers` 输入触发源），构建期把 `src/core.js`（纯函数匹配器）内联进两份产物。零外部依赖。组合行 id：`file-mention`。

## 角色分工

| 角色 | 职责 |
|------|------|
| 维护者（hucj） | 最终决策、`dsh web` 重启、npm 发布、远程推送 |
| AI 助手 | 实现、测试、文档、安装目录同步；**不得擅自 push 远程或发布 npm** |

## 常用命令

- `npm run check` —— build（内联构建 src/ → lib/）+ test（30 用例）
- `npm test` —— node --test 跑 test/core.test.js（纯 core.js 函数）

### DSH agent 沙箱注意事项（Windows）

- `node --test` 会 spawn 子进程，可能被沙箱拦截；失败时改为进程内直跑
- pwsh 命令不要带 `2>&1` 重定向（触发沙箱包装器编码 bug）；原生 exe 用 `cmd /c` 包装
- 禁止用 `&` 分隔多条命令（PowerShell 会误当后台作业）；用 `;` 分隔

## 强制性规则

### 1. 版本号
- 保持 **0.1.x 递增**（当前 0.1.9 → 下一 0.1.10），**禁止跳到 0.2.x**
- 每次版本提交前必须完成下方 2/3/4 项

### 2. 构建不变式（scripts/build.mjs）
- `src/core.js` 必须内联进 **lib/index.js 与 lib/client.js 两份产物**（client 缺失会抛 `ReferenceError: filterFiles is not defined`）
- export 剥离正则必须覆盖：`export {...};` / `export function` / `export async function` / `export const|let|var|class`
- `stripCoreImport` 剥离 `import {...} from './core.js'`（分号可选）
- 修改 `src/` 后必须重跑 `npm run build`，产物语法校验（`node --check`）通过
- 构建幂等：重复 build 不产生 git diff

### 3. 测试
- `test/core.test.js`（node:test，当前 30 用例）
- 修改 `src/core.js` 必须同步补/改测试；全部用例必须通过

### 4. 安装目录同步（每次版本提交必做）
安装目录为**真实目录拷贝**（非符号链接）：
`C:\Users\hu\.dsh\profiles\web\node_modules\@hucj\dsh-file-mention\`

同步**完整清单**（缺一不可）：
```
lib/index.js  lib/client.js  package.json  README.md  README.en.md  cordis.patch.yml
```
> ⚠️ `cordis.patch.yml` 漏拷会导致 dsh web 启动失败（`failed to read overlay ... ENOENT`）；
> 哈希校验用 `Get-FileHash` 对比源与目标。

### 5. 提交与发布
- 常规迭代：`git add -A && git commit`（本地提交，历史保持一个版本一个提交、信息描述代码改动）
- **push 远程 / npm publish 必须用户明确指示**，不自动执行
- 历史重写（filter-branch 等）前必须告知用户并确认；重写前先备份（bundle/tag）

**发布流程（维护者操作，README 不收录，以此为准）**：

```bash
# GitHub（origin 已配置 git@github.com:StephenHu09/dsh-file-mention.git）
git push origin main
git tag v0.1.x && git push origin v0.1.x

# npm（本机 registry 是 npmmirror 镜像，发布必须临时指定官方源）
npm publish --registry=https://registry.npmjs.org        # 认证：~/.npmrc 中 granular token（bypass 2FA，仅限本包）
npm view @hucj/dsh-file-mention version --registry=https://registry.npmjs.org   # 验证

# 版本递增：0.1.x（当前 0.1.10 → 下一 0.1.11）；每次发布前 npm run check + 同步安装目录
# 撤销（72h 内）：npm unpublish @hucj/dsh-file-mention@<版本号> --force
# 弃用（推荐替代）：npm deprecate @hucj/dsh-file-mention@<版本号> "说明"
```

### 6. 文档同步（强制）
- **README.md 与 README.en.md 必须保持同步**：任何对 README.md 的修改（增删章节、改描述、改命令），必须同时更新 README.en.md 的对应内容（结构一致、内容对应翻译），两者一起提交
- README 顶部保留中英文互链（`[English](README.en.md) | 中文` / `English | [中文](README.md)`）
- `docs/architecture.md` 与代码改动同步更新

### 7. 命名与配置约定
- npm 包名：`@hucj/dsh-file-mention`；插件组合行 id：`file-mention`；client bundle id = 包名
- profile 配置：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 与 `dependencies`（`file:` 协议）
- 卸载用 `dsh plugin --profile web remove @hucj/dsh-file-mention`（自动清理依赖 + bundles + 目录）

### 8. 性能边界（改动需实测论证）
- 遍历安全阀：`MAX_DEPTH = 32`、`CAP = 10000`（src/host.js）
- 缓存 TTL 分层：仓库根 60s / 跟踪列表 15s / 变更集+未跟踪 5s / extras walk 15s / `.aiinclude` 规则 60s / 客户端列表 30s（SWR）
- 缓存键均为工作区 cwd（客户端旧版 Host 退化按 sessionId）
- 会话不在内存注册表时回退 `sessionPersistence.inspect()` 解析 cwd（60s 缓存）

### 9. 已知教训（避免重犯）
- 空响应（无 cwd 且空列表）不得写入客户端缓存（会粘 30s 导致 `@` 无反应）
- filter-branch 的 env-filter 中 `$GIT_AUTHOR_DATE` 未被预置，改写时间戳必须用 `git show -s --format=%at` 取 epoch 计算
- 块注释内禁止出现 `*/` 序列（如 `D/**/x/`），会提前终结注释导致语法错误

## 架构（详见 docs/architecture.md）

- src/core.js —— gitignore 语法子集匹配器（纯函数、零依赖、可单测）：
  compileRules / lastMatchRule / matchRules / filterFiles / flattenNestedRules /
  parseStatusZ / dirMayLeadToMatch。
- src/host.js —— Host 半体：注册 `/file-mention/list` POST 路由（inject: sessions, webServer）。
  git ls-files 跟踪文件 + 未跟踪非忽略文件（-o --exclude-standard，新建文件无需 git add）+ .aiinclude 重新纳入 + 未提交变更集；
  分层缓存：仓库根 60s / 跟踪列表 15s / 变更集+未跟踪 5s / extras 15s / .aiinclude 规则 60s；
  git 不可用时降级为 .gitignore 解析 + 全量扫描。
- src/client.js —— Client 半体：inject: inputTriggers，注册 `@` 源（order 4, 组名 file）。
  客户端按工作区 cwd 共享缓存 + stale-while-revalidate（TTL 30s，@ 零等待）；
  warm 钩子会话创建时预取。
- scripts/build.mjs —— 剥离 export/import 后把 core.js 内联进两个产物：
  lib/index.js（ESM 具名导出 name/inject/apply）、lib/client.js（`__ModuleLoader__.load`
  经典脚本 + CJS factory）。产物零外部依赖。

## 约定

- 零外部依赖：纯手写 JS，ESM（"type": "module"），Node >= 22。
- 测试只覆盖纯函数（core.js）；node:test + node:assert/strict。
- .aiinclude 语法与 .gitignore 一致但语义相反（命中即纳入）；嵌套目录配置展平为
  根相对规则、last-match-wins 实现层级覆盖；根 .aiinclude 不存在时不触发嵌套发现。
- 注释与提交信息用中文；设计文档放 docs/。
- 文件路径统一正斜杠（norm()）；遍历有 CAP 10000 / MAX_DEPTH 32 / SKIP 重型目录三重边界。

## 当前状态（2026-08-14 会话快照）

- 已安装到 web profile（~/.dsh/profiles/web/package.json，本地 file: 依赖，真实目录拷贝），GUI 在 http://127.0.0.1:3080
- 工作树干净；lib/ 与 src/ 同步；测试 30/30 通过；版本 0.1.10
- **已发布**：npm registry 最新 0.1.10（官方源）；GitHub 仓库 https://github.com/StephenHu09/dsh-file-mention（main + tag v0.1.10 已推送）
- 已知限制与故障恢复见 README.md 与 docs/recovery.md
