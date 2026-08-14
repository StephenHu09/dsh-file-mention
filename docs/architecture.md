# 架构说明

## 总览

dsh-file-mention 是一个双端（Host + Client）DSH 插件，利用 DSH 的既有扩展点实现"`@` 关联工作区文件"：

- **Client 端**：注册一个 `@` 输入触发源（`inputTriggers`），这是技能 `/` 菜单、`@pluginId`、`@子代理` 所用的同一套机制，因此多源可共存于一个菜单。
- **Host 端**：通过 `webServer` 注册 `/file-mention/list` HTTP 路由，向 Client 提供会话工作区的文件清单。

```
┌─ 浏览器 ──────────────────────────────┐      ┌─ DSH Host ──────────────────────────┐
│ 输入框 @ → inputTriggers 检测          │      │  ctx.sessions → 会话 cwd            │
│   → file 源 candidates()              │ HTTP │  git ls-files -c → 跟踪文件         │
│   → POST /file-mention/list ──────────┼─────▶│  git ls-files -o → 未跟踪非忽略文件  │
│   → 过滤/展示/选中插入 @路径           │◀─────┼─ 返回 { files, dirty, cwd }         │
│ 模型读到 @路径 → read 工具读取          │      │  .aiinclude 扫描 → 重新纳入文件      │
└────────────────────────────────────────┘      └─────────────────────────────────────┘
```

## 关键设计决策

### 1. git 驱动的文件清单（跟踪 + 未跟踪非忽略）

- 用 `git ls-files -c`（跟踪）∪ `git ls-files -o --exclude-standard`（未跟踪且未被忽略）而非全量目录扫描：
  - `.gitignore` 由 git 自行应用，零重复实现；
  - 编译产物（`build/`、`.gradle/` 等）自动排除；
  - 输出即仓库相对路径，天然稳定。
- **为什么必须单独取未跟踪文件**：`git status --porcelain` 会把整个未跟踪目录折叠成一条 `?? dir/`（目录项而非文件项），且 Host 末尾还会过滤掉以 `/` 结尾的条目——新建目录里的新文件从此消失，既进不了 `dirty` 也进不了 `files`；`ls-files -o --exclude-standard` 输出单个文件路径，天然解决折叠问题。未跟踪文件并入 `files`（可直接 @ 引用，无需 `git add`）并同时并入 `dirty`（客户端按未提交变更优先排序，dirty 只参与排序、不新增条目）。
- `git ls-files` / `git status` 在**会话 cwd 下运行**，输出路径天然相对 cwd（子目录会话同样成立），无需仓库根前缀裁剪；`rev-parse --show-toplevel` 仅用于判定 cwd 是否在仓库内（git 不可用时走回退扫描）。⚠️ 教训：曾对 git 输出做 `cwdRel` 前缀裁剪，导致子目录会话列表全空（git 输出已是 cwd 相对路径）。
- **变更一致性**：`git ls-files -d` 剔除已删除文件（index 有、工作区无，如未 `git rm` 的手动删除），避免 @ 后模型读取失败；`git status --porcelain -z` 的重命名/复制条目格式为 `R  NEW\0OLD\0`（**新路径在前**），`parseStatusZ` 取当前条目（新路径）并跳过原路径字段；所有 git 调用统一带 `-c core.quotepath=false`（Linux git 默认对非 ASCII 路径做八进制转义，中文文件名会乱码）。
- **降级路径**：git 不可用/非仓库时，解析 `.gitignore`（实现 gitignore 匹配子集）后全量扫描。此时未跟踪的非忽略文件本就混入——与 git 模式行为一致。

### 2. `.aiinclude` 重新纳入

- 工作区根目录的 `.aiinclude` 采用 gitignore 语法，但语义相反：**命中即纳入**。
- 目录规则（`doc/`）采用"继承式"遍历：目录命中后其下所有文件直接纳入（与 gitignore 目录忽略语义对称）。
- 遍历与 git 跟踪集合并集去重；`SKIP` 重型目录可被 `.aiinclude` 命中覆盖（`build/` 显式纳入时允许进入）。
- 上限：3000 文件、深度 16（实测 doc 目录最深 13 层）。

### 3. 匹配器（src/core.js）

纯函数、零依赖、可单测：

- `compileRules(lines)`：gitignore 语法子集（注释、否定 `!`、目录后缀 `/`、锚定 `/`、`*`/`?`/`**`、含斜杠 vs basename 语义）编译为正则规则；
- `matchRules(rules, rel, isDir)`：最后匹配者生效（gitignore 语义）；
- `filterFiles(files, query, limit)`：客户端菜单过滤（basename/路径、大小写不敏感、限量）；
  命中排序：精确（路径/basename 全等）→ 前缀 → 子串，组内再按 dirty → 非隐藏 → 隐藏 + 字母序；
- `flattenNestedRules(dir, lines)`：嵌套 `.aiinclude` 规则展平为根相对（basename 模式展开为直接 + 跨段两条），与根规则合并后 last-match-wins。

### 4. 构建与打包

- 源码为 ES 模块（`src/`），构建脚本 `scripts/build.mjs` 做**内联拼接**（去掉 import/export 行后把 `core.js` 并入 host/client），产物零外部依赖：
  - `lib/index.js`：ESM，具名导出 `{ name, inject, apply }`（与 @deepseek-ai 系插件一致）；
  - `lib/client.js`：经典脚本 + `window.__ModuleLoader__.load({ id, factory })` CJS factory 包装（与 DSH 客户端模块系统约定一致，页面加载时注册 factory，物化时执行副作用）。
- `cordis.patch.yml` 声明组合行，安装包后由 loader 自动挂载。

## 客户端缓存与失效

- 缓存键为**工作区 cwd**（响应携带 `cwd` 字段）：同工作区多会话共享一份列表；会话首次响应后记录其 cwd，旧版 Host（无 `cwd` 字段）退化为按 sessionId 缓存；
- **stale-while-revalidate**：TTL（30s）内直接返回缓存；过期后**立即返回旧列表**并后台发起刷新（refreshing 集合去重），刷新失败回退旧数据——`@` 菜单任意时刻零等待；
- 同一会话在途请求去重（pending map），避免并发重复拉取；
- 插件卸载/更新时通过 effect disposer 注销输入源并清空缓存。

## Host 侧缓存分层

| 缓存 | TTL | 说明 |
|------|-----|------|
| 仓库根（rev-parse） | 60s | 几乎不变；git init 后最多 60s 识别 |
| git 跟踪列表（ls-files） | 15s | 变化慢；回退扫描（无 git）结果同样缓存 |
| git 变更集 + 未跟踪（status / ls-files -o） | 5s | 变化最快，TTL 最短 |
| `.aiinclude` 规则 | 60s | 根 + 嵌套发现合并结果 |

全部按 cwd 内存缓存；陈旧上限即各 TTL，均短于客户端 30s SWR 缓存，整体一致性由客户端兜底。

## Host 侧 `.aiinclude` 规则

- 根 `.aiinclude` 存在时，全量发现子目录嵌套配置（跳过 `SKIP` 重型目录），展平后与根规则合并；
- 合并结果按 cwd 内存缓存 60 秒（`aiMemo`），避免每次请求重复全量扫描；
- 嵌套否定与遍历继承（`inheritDir`）自然协作：如根 `doc/` + `doc/.aiinclude: !private/` 可阻断 `doc/private` 的继承纳入。

## 安全与资源边界

- 路由仅接受 `sessionId`，路径来自会话自身 header，不暴露任意路径；
- 遍历受 `CAP`（10000）/`MAX_DEPTH`（32）/`SKIP` 目录三重约束；
- git 子进程 stdout 收集上限 8MB、`graceMs` 5 秒；失败即降级。

## 后续计划（Backlog）

- [x] `.aiinclude` 支持嵌套目录多份（按目录层级合并，同 `.gitignore` 层级语义）
- [x] 命中排序：精确/前缀优先于子串（相关性 > 变更状态）
- [x] 多会话共享缓存（按工作区 cwd，同工作区只扫描一次）
- [x] git 结果分层缓存（root 60s / tracked 15s / dirty 5s）
- [x] 客户端 stale-while-revalidate（TTL 过期先展示旧列表、后台刷新，@ 零等待）
- [ ] 可配置：`@` 选中后直接附加文件内容（小文件）或仅路径（大文件）
- [ ] 按扩展名过滤开关（二进制/资源文件）
- [ ] 菜单分组图标定制（依赖 DSH 侧图标枚举交付）
- [ ] CI：GitHub Actions 跑 `npm run check`
