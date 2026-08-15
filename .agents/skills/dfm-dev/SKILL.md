---
name: dfm-dev
description: @hucj/dsh-file-mention（dfm）插件的开发知识——双端架构、常用命令、性能设计（缓存分层/段索引/索引缓存）、调试手段与当前状态。维护/扩展本插件时按需加载；协作规则见 AGENTS.md。
---

# dsh-file-mention 开发知识

DSH（DeepSeek Harness）Web GUI 的 `@` 文件引用插件（npm: `@hucj/dsh-file-mention`，组合行 id: `file-mention`）。
双端架构：Host 半体（`webServer` HTTP 路由 `/file-mention/list`）+ Client 半体（`inputTriggers` 输入触发源），
构建期把 `src/core.js`（纯函数匹配器）内联进两份产物。零外部依赖。

## 常用命令

- `npm run check` —— build（内联构建 src/ → lib/）+ 单元测试（51 用例）+ 集成测试（20 用例，真实 git）
- `npm test` —— 纯 core.js 函数（秒级）；`npm run test:it` —— host 集成（真实 git + 真实 fs，约 20-30s）
- 构建不变式：core.js 必须内联进 lib/index.js 与 lib/client.js 两份产物（client 缺失抛
  `ReferenceError: filterFiles is not defined`）；修改 src/ 后必须重跑 build；构建幂等（重复 build 无 diff）

### DSH agent 沙箱注意事项（Windows）

- `node --test` 会 spawn 子进程，可能被沙箱拦截；失败时改为进程内直跑
- pwsh 命令不要带 `2>&1` 重定向（触发沙箱包装器编码 bug）；原生 exe 用 `cmd /c` 包装
- 禁止用 `&` 分隔多条命令（PowerShell 会误当后台作业）；用 `;` 分隔

## 架构

- `src/core.js` —— gitignore 语法子集匹配器（纯函数、零依赖、可单测）：
  compileRules / lastMatchRule / matchRules / filterFiles / flattenNestedRules / parseStatusZ /
  dirMayLeadToMatch / stripRepoPrefix / deriveDirs / visibleDirs / buildIndex（含段索引）/
  TOP_DIRTY 常量 / topK（快速选择，中位 pivot 防已排序数组退化）
- `src/host.js` —— `/file-mention/list` POST 路由（inject: sessions, webServer）：
  git ls-files 跟踪 + 未跟踪非忽略（-o --exclude-standard）+ 已删除剔除（-d）+ .aiinclude 纳入 + 变更集；
  所有 git 调用带 `-c core.quotepath=false`；ls-files 输出天然相对 cwd，status 输出仓库根相对
  （按 `rev-parse --show-prefix` 裁剪）；dirty 携带 mtime（2c 步骤 node:fs/promises stat，
  dsh fs 服务无 mtime）；git 不可用降级 .gitignore 解析 + 全量扫描
- `src/client.js` —— 注册 `@` 源（order 4, 组名 file）：
  客户端按 cwd 共享缓存 + stale-while-revalidate（TTL 30s）；warm 钩子预取 + 预构建目录/索引；
  candidates：deriveDirs → visibleDirs → filterFiles（limit 30，dirty 数组直传含 mtime）→
  映射 name（目录带尾斜杠）/description/icon（📁 或 4 类 emoji）
- `scripts/build.mjs` —— 剥离 export/import 后内联 core.js：
  lib/index.js（ESM 具名导出 name/inject/apply）、lib/client.js（`__ModuleLoader__.load` CJS factory）

### 排序与目录规则（filterFiles）

三键排序：score（0 精确 / 1 前缀 / 2 子串）→ rank（0 变更置顶 TOP_DIRTY=5 按 mtime 降序 /
1 目录 / 2 普通文件 / 3 隐藏路径）→ 组内字母序（rank0 组按 mtime，相等回退字母序）。
目录显示：visibleDirs 逐级展开（深度 = 查询词 `/` 数量 + 1），单段查询 basename 前缀匹配的
深层目录突破深度直达。目录优先级：变更文件 → 📁 目录 → 普通文件 → 隐藏。

### 性能设计（大仓库 3 万文件实测 45-57ms → 4-15ms）

- **score 分层 + limit 即停**：子串大组（最贵）只在精确+前缀不足 limit 时扫描
- **rank 预计算缓存**：比较器查表，不重复 split/startsWith
- **deriveDirs/buildIndex 缓存**：files 数组引用不变（30s 缓存命中同一对象）时复用
- **段索引**：路径按 / 拆段，段名按小写首字符分桶（segBuckets）+ 段→路径倒排（segments，
  列表构建时排序）；单段查询只遍历首字符桶，恰一个命中段走 12 桶（score×rank）直接分流
  （O(n) 无 sort/topK）；含 / 查询取最短命中段缩小候选 + 路径小写验证（语义与旧一致）；
  跨段子串（'b/c' 匹配 'ab/cd'）不再命中（实际查询不存在）
- **topK**：快速选择 + 前缀 sort，中位 pivot（输入常为已排序数组，pivot 取末尾会 O(n²)）
- **limit 30**：DSH 菜单无虚拟化全量渲染，行数即每次按键的渲染成本
- **warm 预构建**：会话创建时后台预取列表 + 构建目录/索引（buildIndex 大仓库 ~100-140ms 无感）
- **防抖不可行**：DSH 框架每次按键把菜单置 pending 并清空 items（显示 loading），candidates
  延迟返回必然闪烁；且无推送 API——停顿后无法自动更新（拉模型）

### 缓存分层（host）

仓库根 60s / 跟踪列表 15s / 变更集+未跟踪+已删除 5s / extras walk 15s / .aiinclude 规则 60s /
客户端列表 30s（SWR）。缓存键均为工作区 cwd（客户端旧版 Host 退化按 sessionId）。
遍历安全阀：MAX_DEPTH = 32、CAP = 10000、SKIP 重型目录。

## 调试手段

- 实测列表：`POST http://127.0.0.1:3080/file-mention/list` body `{"sessionId":"<id>"}`
- 探针法验证文件关联：临时建/删文件 + 等缓存过期（客户端 30s / host 变更 5s）
- 性能基准：node 脚本构造大文件列表（3 万）跑 deriveDirs/buildIndex/filterFiles 计时
- 排序行为预览：node 直跑 filterFiles 打印顺序（配合回归矩阵测试验证语义）
- 判定运行进程版本：POST 看 dirty 是否含 mtime（v0.1.14+ 特征）、bundle 是否含 segBuckets

## 当前状态（2026-08-16 快照）

- 版本 0.1.15（v0.1.14 内容已并入）；测试 51 单测 + 20 集成全绿
- 已发布：npm 0.1.13（latest）；GitHub main + tag v0.1.13（hucj09 仓库）；
  0.1.14/0.1.15 待发布
- profile 安装：file: 依赖（真实目录拷贝），dsh web 重启后生效
- 发布流程（含 pnpm-workspace 豁免更新、npmmirror 同步延迟）见 AGENTS.md 规则 5
- 版本历史见 docs/CHANGELOG.md；架构细节见 docs/architecture.md

## 文档指引

- README.md / README.en.md —— 面向使用者（安装/卸载/配置）
- AGENTS.md —— 面向维护者与 AI 助手的规则与约束（唯一维护来源）
- docs/CHANGELOG.md —— 版本历史与发布记录
- docs/architecture.md —— 设计细节
- docs/recovery.md —— 故障恢复教程
- docs/chip-preview.html —— 输入框 chip 方案调研参考（结论：不可行，见 dfm-lessons skill）
