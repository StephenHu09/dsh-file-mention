# CHANGELOG

`@hucj/dsh-file-mention` 版本历史与发布记录（维护者视角；使用者文档见 README.md）。

仓库：https://github.com/hucj09/dsh-file-mention
发布渠道：npm（官方源）+ GitHub（main + tag v0.1.x）

---

## v0.1.14（2026-08-15 · 待发布）

- **目录引用**：目录由文件列表自动派生（deriveDirs，零额外扫描），@ 菜单可选中目录并插入 `@docs/ ` 供模型探索
- 目录显示 📁 图标、名称带尾斜杠（`docs/`）；**集中置前**（变更文件 → 目录 → 普通文件 → 隐藏路径）
- **目录逐级展开**（visibleDirs）：目录显示深度 = 查询词 `/` 数量 + 1——`@app` 顶层、`@app/` 第二层、`@app/src/` 第三层，避免深层子目录排队刷屏；**单段查询直达子目录**（basename 前缀匹配突破深度，`@10_logcat_analyze` 直接命中 `docs/10_logcat_analyze/`，目录置前）
- **变更置顶限数量**：dirty 携带 mtime（host 端 node:fs stat，dsh fs 服务无 mtime），只置顶最近修改的 5 个（TOP_DIRTY，mtime 降序），避免变更过多时压制目录；无 mtime 旧格式回退全量置顶
- **排序回归矩阵**：新增空查询/查询词下 score/rank/mtime 叠加的完整顺序快照测试，规则改动必须同步更新
- 测试 51 单测 + 20 集成（新增 TOP_DIRTY 排序 / 旧格式回退 / 回归矩阵用例）

## v0.1.13（2026-08-15 · 已发布 npm + GitHub）

- 4 类类型图标（⌨️ 代码 / 📝 文档 / 🖼️ 图片 / 📄 其他）
- @ 候选菜单显示适配：加宽至 720px、行字号 13px、紧凑行高（同屏 +25% 行数）
- 未提交变更优先排序；候选行显示干净文件名
- 已删除文件不残留；重命名/复制的旧路径状态完整（D 标记）
- 测试 39 单测 + 20 集成（含 8 种 git 状态区分矩阵）

## v0.1.11（2026-08-14 · 已发布）

- **bug 修复批次**：rename 取新路径（真实 -z 格式新路径在前）、已删除文件剔除（ls-files -d）、子目录会话列表、中文路径（quotepath 关闭）
- **代码审查修复**：子目录 dirty 按 `--show-prefix` 裁剪（status 输出仓库根相对 vs ls-files cwd 相对的不对称）、缓存数组写副本（防别名污染）
- 集成测试接入 npm run check（18 用例）

## v0.1.10（2026-08-14 · 已发布）

- @ 菜单纳入**未跟踪非忽略文件**（git ls-files -o --exclude-standard），新建文件无需 git add 即可引用
- README 增加功能演示截图（docs/images/example.png）

## v0.1.9（2026-08-14 · 已发布）

- 发布前定名：scoped 包 `@hucj/dsh-file-mention`；补 repository / publishConfig.access / author 字段

## v0.1.8（2026-08-14 · 已发布）

- 缓存体系优化与历史会话支持（分层缓存 TTL：仓库根 60s / 跟踪 15s / 变更 5s）

## v0.1.7（2026-08-14）

- 遍历安全阀提升：MAX_DEPTH 16→32、CAP 3000→10000

## v0.1.6（2026-08-14）

- P1 优化批次：精确匹配优先、跨会话共享缓存（按 cwd）、.aiinclude 嵌套支持

## v0.1.5（2026-08-14）

- 未提交变更优先排序（dirty 置顶）

## v0.1.4（2026-08-14）

- 空查询默认展示优化（非隐藏目录优先，最多 100 条）

## v0.1.3（2026-08-14）

- @ 输入零等待（客户端 stale-while-revalidate 缓存）

## v0.1.2（2026-08-14）

- client 产物内联 core 并剥离 export 声明（构建不变式建立）
- 新增 docs/recovery.md 故障恢复教程

## v0.1.1（2026-08-14）

- 正式包改用 webServer HTTP 路由（/file-mention/list）

## v0.1.0（2026-08-14）

- 首个版本：@ 关联工作区文件插件（git 驱动过滤 + .gitignore 语义）
