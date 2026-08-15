---
name: dfm-lessons
description: @hucj/dsh-file-mention（dfm）项目的已知教训与踩坑记录——git 行为、组件层限制、发布流程坑、性能与框架约束。排查回归或设计新功能前先查阅，避免重犯历史错误。
---

# dsh-file-mention 已知教训

排查问题、设计新功能、遇到"之前好像修过"的场景时查阅本节。每条都标注了背景与规避方式。

## git 行为（实测确认）

- **空响应不得缓存**：`/file-mention/list` 返回空列表且无 cwd（会话未就绪/未知）时，客户端不得写入缓存——否则空结果粘 30s，`@` 完全无反应
- **ls-files 与 status 路径基准不对称**：`git ls-files`（-c/-o/-d）在子目录输出**相对 cwd** 的路径（勿裁剪）；
  但 `git status --porcelain` 在子目录输出**仓库根相对**路径——dirty 必须按 `rev-parse --show-prefix` 裁剪
  （v0.1.10 统一裁剪 → ls-files 列表全空；v0.1.11 整体删除裁剪 → 子目录 dirty 失效）
- **rename 条目格式**：`git status --porcelain -z` 重命名条目 `R  NEW\0OLD\0`（**新路径在前**），
  parseStatusZ 取当前条目并跳过原路径字段；原路径字段也输出为 D（git 可能把同内容删除配对成 R 源）
- **quotepath**：git 默认 `core.quotepath=true`（Linux 对非 ASCII 路径八进制转义），所有 git 调用统一加 `-c core.quotepath=false`
- **已删除文件残留**：`git ls-files -c` 会列出 index 有、工作区无的文件（手动删除未 git rm），
  需 `git ls-files -d` 剔除，否则 @ 后模型读取失败
- **git status 目录折叠**：未跟踪目录折叠成 `?? dir/`（尾斜杠），需 `ls-files -o` 展开单文件

## 组件层限制（2026-08 实测，勿重复尝试）

- **输入框引用变色不可行**：
  - textRef 扫描正则 `(^|\s)([/@])([\w-]+)` 组件写死，只匹配**单段**——`@docs/images/x.png` 只能匹配 `@docs`，
    lexicon 提供什么名字都无法让含 `/`、`.` 的完整路径整体变蓝
  - chip（`{insert: ReferenceInsert}`）占位符 U+FFFC 在 DshChipCell 字体中 advance = **4em**（TTF 实测），
    16px 字号下 chip 宽固定 64px、label 视觉可用约 57px（≈7 个 ASCII 字符）——路径必然截断，
    官方 `@subagent` 源因此用 `{text}` 而非 `{insert}`；调研细节见 docs/chip-preview.html
- **防抖/推送不可行**：DSH 菜单是拉模型 + 组件层限制——
  每次按键框架把菜单置 pending 并清空 items（candidates 延迟返回必闪烁 loading）；
  无推送 API（停顿后无法自动更新菜单）；菜单无虚拟化全量渲染（行数即每次按键的渲染成本，limit 30 权衡）。
  不要在 candidates 里做防抖/延迟返回，不要尝试手动触发菜单刷新
- **菜单样式覆盖**：可用高特异性选择器（`div[role="listbox"]` / `button[role="option"]`，0,1,1 > CSS Module 0,1,0）
  覆盖官方样式（加宽/字号/行高），但 CSS Module 哈希类名不稳定，必须用 DOM 稳定特征（role/data 属性）

## 发布与安装流程坑

- **npmmirror 同步延迟**（实测 ~20 分钟）+ pnpm 元数据缓存粘性：npm 发布后短时间内 `dsh plugin add`/`pnpm add`
  会解析到旧 latest（0.1.13 发布后 add 装成 ^0.1.11）。诊断：`npm view <pkg> version`（默认 registry 看镜像同步）；
  修复：`pnpm add <pkg>@latest` 或显式 `<pkg>@<版本>` 刷新缓存
- **minimumReleaseAge 策略**：pnpm 11 发布不足 2 天的包被拒（默认宽松模式自动加豁免，strict 模式才拦）；
  发布后更新 profile 的 `pnpm-workspace.yaml` `minimumReleaseAgeExclude` 为新版本
- **dsh plugin remove 偶发残留**：pnpm 阶段超时中断时 bundles 行可能残留——手动补删后必须
  用 `node -e "JSON.parse(...)"` 严格校验（PowerShell ConvertFrom-Json 宽容容忍尾逗号，Node 严格拒绝）
- **发布后豁免清单**：pnpm-workspace.yaml 的豁免条目格式 `包名@版本`，`||` 语法可用但拆行更保险

## 代码与构建坑

- **filter-branch 时间戳**：env-filter 中 `$GIT_AUTHOR_DATE` 未被预置，改写时间戳必须用
  `git show -s --format=%at` 取 epoch 计算；改历史前备份（bundle/tag）并告知用户
- **块注释**：禁止出现 `*/` 序列（如 `D/**/x/`），会提前终结注释导致语法错误
- **topK 退化**：快速选择 pivot 取末尾元素时，已排序输入（host 输出有序）退化为 O(n²)——
  必须用中位 pivot（三数取中）
- **段索引边界**：index 只覆盖 files 时，混入的目录（visibleDirs 输出）查表返回 undefined——
  必须回退直接计算或让 index 覆盖目录；跨段子串（'b/c' 匹配 'ab/cd'）段索引不命中（实际查询不存在）
- **PowerShell 沙箱**：pwsh 不要带 `2>&1` 重定向（触发包装器编码 bug）；原生 exe 用 `cmd /c` 包装；
  禁止用 `&` 分隔命令（误当后台作业）；`node --test` 可能被沙箱拦截，失败改进程内直跑
