# 架构说明

## 总览

dsh-file-mention 是一个双端（Host + Client）DSH 插件，利用 DSH 的既有扩展点实现"`@` 关联工作区文件"：

- **Client 端**：注册一个 `@` 输入触发源（`inputTriggers`），这是技能 `/` 菜单、`@pluginId`、`@子代理` 所用的同一套机制，因此多源可共存于一个菜单。
- **Host 端**：通过 `webServer` 注册 `/file-mention/list` HTTP 路由，向 Client 提供会话工作区的文件清单。

```
┌─ 浏览器 ──────────────────────────────┐      ┌─ DSH Host ──────────────────────────┐
│ 输入框 @ → inputTriggers 检测          │      │  ctx.sessions → 会话 cwd            │
│   → file 源 candidates()              │ HTTP │  git ls-files -c → 跟踪文件         │
│   → POST /file-mention/list ──────────┼─────▶│  .aiinclude 扫描 → 重新纳入文件      │
│   → 过滤/展示/选中插入 @路径           │◀─────┼─ 返回 { files: [...] }              │
│ 模型读到 @路径 → read 工具读取          │      │                                     │
└────────────────────────────────────────┘      └─────────────────────────────────────┘
```

## 关键设计决策

### 1. 只列 git 跟踪文件

- 用 `git ls-files -c` 而非全量目录扫描：
  - `.gitignore` 由 git 自行应用，零重复实现；
  - 编译产物（`build/`、`.gradle/` 等）与未跟踪文件（`.codebuddy/`、`.vscode/` 等）自动排除；
  - 输出即仓库相对路径，天然稳定。
- 会话 cwd 位于仓库子目录时，将仓库相对路径转换为 cwd 相对路径（`rev-parse --show-toplevel` + 前缀裁剪）。
- **降级路径**：git 不可用/非仓库时，解析 `.gitignore`（实现 gitignore 匹配子集）后全量扫描。此时未跟踪的非忽略文件会混入——文档中已注明。

### 2. `.aiinclude` 重新纳入

- 工作区根目录的 `.aiinclude` 采用 gitignore 语法，但语义相反：**命中即纳入**。
- 目录规则（`doc/`）采用"继承式"遍历：目录命中后其下所有文件直接纳入（与 gitignore 目录忽略语义对称）。
- 遍历与 git 跟踪集合并集去重；`SKIP` 重型目录可被 `.aiinclude` 命中覆盖（`build/` 显式纳入时允许进入）。
- 上限：3000 文件、深度 16（实测 doc 目录最深 13 层）。

### 3. 匹配器（src/core.js）

纯函数、零依赖、可单测：

- `compileRules(lines)`：gitignore 语法子集（注释、否定 `!`、目录后缀 `/`、锚定 `/`、`*`/`?`/`**`、含斜杠 vs basename 语义）编译为正则规则；
- `matchRules(rules, rel, isDir)`：最后匹配者生效（gitignore 语义）；
- `filterFiles(files, query, limit)`：客户端菜单过滤（basename/路径、大小写不敏感、限量）。

### 4. 构建与打包

- 源码为 ES 模块（`src/`），构建脚本 `scripts/build.mjs` 做**内联拼接**（去掉 import/export 行后把 `core.js` 并入 host/client），产物零外部依赖：
  - `lib/index.js`：ESM，具名导出 `{ name, inject, apply }`（与 @deepseek-ai 系插件一致）；
  - `lib/client.js`：经典脚本 + `window.__ModuleLoader__.load({ id, factory })` CJS factory 包装（与 DSH 客户端模块系统约定一致，页面加载时注册 factory，物化时执行副作用）。
- `cordis.patch.yml` 声明组合行，安装包后由 loader 自动挂载。

## 客户端缓存与失效

- 每个会话一份列表缓存，TTL 30 秒；
- 拉取失败回退空列表并允许下次重试；
- 插件卸载/更新时通过 effect disposer 注销输入源并清空缓存。

## 安全与资源边界

- 路由仅接受 `sessionId`，路径来自会话自身 header，不暴露任意路径；
- 遍历受 `CAP`（3000）/`MAX_DEPTH`（16）/`SKIP` 目录三重约束；
- git 子进程 stdout 收集上限 8MB、`graceMs` 5 秒；失败即降级。

## 后续计划（Backlog）

- [ ] `.aiinclude` 支持嵌套目录多份（按目录层级合并，同 `.gitignore` 层级语义）
- [ ] 可配置：`@` 选中后直接附加文件内容（小文件）或仅路径（大文件）
- [ ] 按扩展名过滤开关（二进制/资源文件）
- [ ] 菜单分组图标定制（依赖 DSH 侧图标枚举交付）
- [ ] CI：GitHub Actions 跑 `npm run check`
