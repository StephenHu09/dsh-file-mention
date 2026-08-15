# AGENTS.md —— dsh-file-mention 协作规则

本文档为 AI 编码助手与本仓库维护者（hucj）协作时的**规则与约束**，是本项目规则的**唯一维护来源**。
开发知识（架构、命令、调试）按需加载项目 skill：`.agents/skills/dfm-dev`。

**文档分工**：
- **README.md / README.en.md** —— 面向**使用者**的教程与说明（安装、卸载、配置、发布指引）
- **AGENTS.md** —— 面向**维护者与 AI 助手**的工作规则（版本、构建、同步、提交约定）
- **docs/CHANGELOG.md** —— 版本历史与发布记录；**docs/architecture.md** —— 设计细节

## 项目定位

npm 包 **`@hucj/dsh-file-mention`**：DSH（DeepSeek Harness）Web GUI 的 `@` 文件引用插件。
双端架构：Host 半体（`webServer` HTTP 路由 `/file-mention/list`）+ Client 半体（`inputTriggers` 输入触发源），
构建期把 `src/core.js`（纯函数匹配器）内联进两份产物。零外部依赖。组合行 id：`file-mention`。

## 角色分工

| 角色 | 职责 |
|------|------|
| 维护者（hucj） | 最终决策、`dsh web` 重启、npm 发布、远程推送 |
| AI 助手 | 实现、测试、文档、安装目录同步；**不得擅自 push 远程或发布 npm** |

## 强制性规则

### 1. 版本号
- 保持 **0.1.x 递增**（当前 0.1.16 → 下一 0.1.17），**禁止跳到 0.2.x**
- **仅代码/功能改动才递增版本号**；纯文档/规则/skill 等非代码修改（如本文档、README、skill、.agents）**不更新版本号**，正常提交即可
- 每次版本提交前必须完成下方 2/3/4 项

### 2. 构建不变式（scripts/build.mjs）
- `src/core.js` 必须内联进 **lib/index.js 与 lib/client.js 两份产物**（client 缺失会抛 `ReferenceError: filterFiles is not defined`）
- export 剥离正则必须覆盖：`export {...};` / `export function` / `export async function` / `export const|let|var|class`
- `stripCoreImport` 剥离 `import {...} from './core.js'`（分号可选）
- 修改 `src/` 后必须重跑 `npm run build`，产物语法校验（`node --check`）通过
- 构建幂等：重复 build 不产生 git diff

### 3. 测试
- `test/core.test.js`（node:test，当前 51 用例）—— 纯函数；含排序**回归矩阵**（空查询/查询词下 score/rank/mtime 叠加快照，改动规则必须同步更新矩阵）
- `test/host.integration.test.js`（node:test，当前 20 用例）—— host 集成：独立临时 git 仓库 + 真实 git/fs，模拟新建/修改/重命名/删除/子目录/忽略/回退/缓存场景；**每次版本提交前跑 npm run check 必须全绿**
- 修改 `src/core.js` 必须同步补/改测试；修改 `src/host.js` 涉及列表行为时必须同步补/改集成测试（先复现场景再改代码）
- 集成测试注意：host 缓存为**模块级共享**，同一仓库多实例会命中旧缓存——需要多状态的用例拆成独立仓库/独立用例

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
- **提交必须用户明确指示**：一个功能可能反复修改多次才完整，AI 不得在迭代过程中自行 `git commit`；用户要求提交时统一执行 `git add -A && git commit`（本地提交，历史保持一个版本一个提交、信息描述代码改动）
- **push 远程 / npm publish 必须用户明确指示**，不自动执行
- 历史重写（filter-branch 等）前必须告知用户并确认；重写前先备份（bundle/tag）

**发布流程（维护者操作，README 不收录，以此为准）**：

```bash
# GitHub（origin 已配置 git@github.com:hucj09/dsh-file-mention.git）
git push origin main
git tag v0.1.x && git push origin v0.1.x

# npm（本机 registry 是 npmmirror 镜像，发布必须临时指定官方源）
npm publish --registry=https://registry.npmjs.org        # 认证：~/.npmrc 中 granular token（bypass 2FA，仅限本包）
npm view @hucj/dsh-file-mention version --registry=https://registry.npmjs.org   # 验证

# 版本递增：0.1.x（当前 0.1.16 → 下一 0.1.17）；每次发布前 npm run check + 同步安装目录
# 发布后：pnpm-workspace.yaml 的 minimumReleaseAgeExclude 更新为新版本（否则 2 天内 pnpm add 被拒）
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
- 缓存 TTL 分层：仓库根 60s / 跟踪列表 15s / 变更集+未跟踪+已删除 5s / extras walk 15s / `.aiinclude` 规则 60s / 客户端列表 30s（SWR）
- 缓存键均为工作区 cwd（客户端旧版 Host 退化按 sessionId）
- 会话不在内存注册表时回退 `sessionPersistence.inspect()` 解析 cwd（60s 缓存）
- 大仓库输入性能（3 万文件 <15ms）由段索引/分层/索引缓存保证，改动不得破坏（回归矩阵 + 基准验证）

### 9. 已知教训（避免重犯）
- 已知教训（git 行为、组件层限制、发布流程坑、代码与构建坑）由项目 skill **`dfm-lessons`** 管理，
  排查回归或设计新功能前先查阅（`.agents/skills/dfm-lessons`），新教训追加到该 skill 而非本文档

## 架构

详见项目 skill `.agents/skills/dfm-dev` 与 docs/architecture.md
（core 纯函数 / host 路由与缓存 / client 源与索引 / 段索引与排序规则）。

## 约定

- 零外部依赖：纯手写 JS，ESM（"type": "module"），Node >= 22。
- 测试分层：单元测试只覆盖纯函数（core.js）；集成测试覆盖 host 列表行为（真实 git + 真实 fs，node:test + node:assert/strict）。
- .aiinclude 语法与 .gitignore 一致但语义相反（命中即纳入）；嵌套目录配置展平为
  根相对规则、last-match-wins 实现层级覆盖；根 .aiinclude 不存在时不触发嵌套发现。
- 注释与提交信息用中文；设计文档放 docs/。
- 文件路径统一正斜杠（norm()）；遍历有 CAP 10000 / MAX_DEPTH 32 / SKIP 重型目录三重边界。

> 版本历史与发布记录见 docs/CHANGELOG.md（本文件不再维护「当前状态」快照）。
