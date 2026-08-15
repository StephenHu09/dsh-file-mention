# CHANGELOG

`@hucj/dsh-file-mention` 版本历史与发布记录（维护者视角；使用者文档见 README.md）。

仓库：https://github.com/hucj09/dsh-file-mention
发布渠道：npm（官方源）+ GitHub（main + tag v0.1.x）

---

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
