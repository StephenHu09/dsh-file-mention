# @hucj/dsh-file-mention

DSH（DeepSeek Harness）Web GUI 的 **`@` 关联工作区文件**插件：在聊天输入框输入 `@`，按输入字符实时过滤并选择工作区文件，选中后插入 `@相对路径`，模型即可直接读取该文件——类似 Codex CLI / Claude Code CLI 的 `@file` 引用体验。

> npm 包名 `@hucj/dsh-file-mention`（个人 scoped 包）；插件组合行 id 为 `file-mention`。

- **只列 git 跟踪的文件**：天然遵守 `.gitignore`，编译产物、未跟踪文件自动排除
- **`.aiinclude` 重新纳入**：被忽略/未跟踪、但 AI 需要访问的文件（如项目文档）可显式加回扫描范围
- **零外部依赖**：Host/Client 双端均为纯手写代码 + 手写构建脚本

## 功能特性

| 特性 | 说明 |
|------|------|
| `@` 输入触发 | 与技能 `/` 菜单、`@pluginId`、`@子代理` 同一套 `inputTriggers` 机制，多源并存 |
| 实时过滤 | 按文件名或完整路径匹配（大小写不敏感），最多展示 100 条 |
| 命中排序 | **精确匹配**（路径/basename 全等）→ **前缀匹配** → 子串匹配（组内再按变更优先 + 字母序） |
| 默认排序 | **未提交变更优先**（git status，含 staged/unstaged/删除/未跟踪）→ 非隐藏目录 → 隐藏目录（组内字母序） |
| git 跟踪过滤 | 通过 `git ls-files` 获取，自动跳过 `.gitignore` 忽略项、编译产物、未跟踪文件 |
| `.aiinclude` | gitignore 语法，把忽略目录/文件重新纳入（目录规则含子级继承，支持子目录嵌套配置） |
| 回退模式 | git 不可用/非仓库时自动降级为 `.gitignore` 解析 + 全量扫描 |
| 缓存 | 客户端按**工作区 cwd 共享** + **stale-while-revalidate**（TTL 30s 过期先返回旧列表、后台刷新，`@` 永远零等待）；Host 侧 git 结果分层缓存（仓库根 60s / 跟踪列表 15s / 变更 5s）；会话创建时后台预热（warm 钩子） |
| 剪枝遍历 | `.aiinclude` 只遍历可能命中的目录（doc/ 场景实测 16ms vs 全树 822ms） |
| 安全边界 | 文件总数上限 10000、遍历深度 32、跳过重型目录 |

## 安装

### 方式一：npm 发布后（推荐）

```bash
dsh plugin --profile web add @hucj/dsh-file-mention
```

### 方式二：本地路径（开发调试）

```bash
dsh plugin --profile web add file:D:/path/to/dsh-file-mention
```

安装后重启 dsh web（或热重载生效），在输入框输入 `@` 即可使用。

> 注：`dsh.client.inject` 为空、插件自身 `inject: ['inputTriggers']` 声明硬依赖，宿主需已组装 `@deepseek-ai/dsh-client-ui-input-trigger`（标准 web 部署默认包含）。

## `.aiinclude` 配置

在**工作区根目录**创建 `.aiinclude` 文件（语法与 `.gitignore` 一致）：

```gitignore
# 被 .gitignore 忽略、但 AI 需要 @ 访问的文件/目录
doc/
.superpowers/sdd/**
.vscode/settings.json
build/generated/**
```

| 语法 | 含义 | 示例 |
|------|------|------|
| `#` | 注释 | `# 说明` |
| `dir/` | 目录规则，其下所有文件（含子级）纳入 | `doc/` |
| `path/**` | 目录下任意深度 | `.codebuddy/**` |
| `*.ext` | 任意层级的 basename 匹配 | `*.log` |
| `!pattern` | 否定（最后匹配者生效） | `!doc/private/` |
| `/pattern` | 锚定于工作区根 | `/build` |

修改后 **30 秒内**（客户端缓存）或**刷新页面**生效。

### 子目录嵌套配置

子目录也可以放自己的 `.aiinclude`（gitignore 层级语义：规则相对该目录生效，且**覆盖**根配置）：

```gitignore
# doc/.aiinclude —— 只对 doc/ 下生效
!private/            # 排除 doc/private（根配置 doc/ 的继承在此被覆盖）
*.md                 # 额外纳入 doc/ 下任意深度的 .md
```

嵌套规则会展开为根相对规则并与根规则合并（后读入者优先，`!` 否定同样生效）。
限制：需要**根 `.aiinclude` 存在**才触发嵌套发现；`node_modules` 等重型目录内的嵌套配置不读取；
Host 侧规则缓存 60 秒（修改嵌套配置后最多 1 分钟生效）。

### 典型场景

- 项目文档目录不入库（`.gitignore: doc/`），但 AI 复盘/查询需要 → `.aiinclude: doc/`
- 本地辅助工具产物不入库，但 AI 需要读取 → `.aiinclude: .superpowers/**`
- 不希望 `.aiinclude` 本身入库 → 在 `.gitignore` 中追加 `.aiinclude`

## 开发

```bash
npm run build   # 构建 src/ → lib/（零依赖，纯拷贝 + 语法校验）
npm test        # 匹配器单元测试（node:test）
npm run check   # 构建 + 测试
```

### 目录结构

```
src/
  core.js     # gitignore/.aiinclude 规则匹配核心（纯函数，可独立测试）
  host.js     # Host 半体：git ls-files + .aiinclude 扫描（/file-mention/list HTTP 路由）
  client.js   # Client 半体：@ 输入触发源（inputTriggers）
scripts/
  build.mjs   # 构建：内联 core 并生成 lib/index.js（ESM）与 lib/client.js（__ModuleLoader__ 包装）
test/
  core.test.js
lib/          # 构建产物（随包发布，安装即用）
docs/
  architecture.md   # 架构与设计说明
```

## 架构摘要

```
浏览器输入框输入 @
  → inputTriggers 触发 file 源
  → POST /file-mention/list（{ sessionId }）
  → Host：git ls-files（跟踪文件）∪ .aiinclude 扫描（重新纳入）
  → 返回相对路径列表 → 过滤展示 → 选中插入 @路径
  → 模型收到路径文本，用文件工具读取
```

详见 [docs/architecture.md](docs/architecture.md)。

## 发布

### GitHub

```bash
git init && git add -A && git commit -m "feat: initial release"
git remote add origin git@github.com:<you>/dsh-file-mention.git
git push -u origin main
# 打标签
git tag v0.1.0 && git push origin v0.1.0
```

### npm（可选，发布后即可 dsh plugin add 安装）

```bash
npm login
npm publish
```

## 已知限制

- 只传路径、不附加内容：模型按路径读取文件（与 Claude Code 直接附加内容不同）
- `.aiinclude` 嵌套配置依赖根配置存在才被发现；重型目录（node_modules 等）内不读取
- Host 侧 `.aiinclude` 规则缓存 60 秒、git 结果缓存 5~60 秒（分层）、客户端列表 30 秒（SWR 先展示旧列表），编辑配置后数据最多 ~90 秒内收敛
- git 跟踪过滤依赖本机 git；无 git 时降级模式会包含未跟踪的非忽略文件
- 冷启动（首次请求）含嵌套发现全量扫描，约 1~2 秒；warm 预热后基本零等待

## 故障恢复：插件导致 dsh web 起不来怎么办

`dsh web` 启动时组合 profile 配置并执行插件 `apply`；若插件在启动阶段抛错，整个启动会失败。
恢复思路：**在启动前让出错的插件不参与组合**（配置文件随时可编辑，不需要 dsh 运行）。

三种方式（由快到彻底）：

1. **临时禁用（最快，不动配置）**：`dsh web --patch disable.yml`，其中：
   ```yaml
   - id: file-mention    # 出错插件的组合行 id（见启动报错信息）
     disabled: true
   ```
2. **永久移除（首选）**：编辑 `~/.dsh/profiles/web/package.json`，从 `dsh.profile.bundles` 删除该包行，重新启动
3. **彻底清理**：`dsh plugin --profile web remove <包名>`

完整教程（含原理、验证技巧、FAQ、动态插件对比）：**[docs/recovery.md](docs/recovery.md)**

> 提示：动态插件（cordis_define/run）是运行时注入、不写入 profile 配置，出错用
> `cordis_undefine` 即可，永远不会影响 dsh 启动。

## License

[MIT](LICENSE) © 2026 hucj
