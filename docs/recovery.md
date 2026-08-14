# 故障恢复：插件导致 `dsh web` 起不来

> 适用场景：安装/升级插件后，`dsh web` 启动即报错退出，终端出现类似：
>
> ```
> Error: dsh: plugin tree failed to load: failed to apply loader entry xxx (pkg-name): <错误信息>
>     at ... dsh-app-boot/lib/index.js
> ```
>
> **核心原理**：`dsh web` 启动时按 profile 配置组合插件树，并逐个执行插件 `apply()`。
> 任何插件在启动阶段抛错，都会导致整个启动失败。
> 恢复的思路只有一条：**在启动前让出错的插件不参与组合**。
> 配置文件随时可编辑，不需要 dsh 运行——所以总能恢复。

---

## 方法一：`--patch` 临时禁用（最快，不动任何配置）

把出错插件的组合行禁用掉，用 CLI 的 `--patch` 覆盖层启动。**不修改任何配置文件**，适合临时绕过、先让 dsh 跑起来。

1. 新建一个补丁文件（任意位置，如 `D:\disable-plugin.yml`）：

   ```yaml
   # 按组合行 id 禁用插件（id 见 package.json bundles 或启动报错信息）
   - id: file-mention
     disabled: true
   ```

   > `id` 是组合行的 id（报错信息里 `failed to apply loader entry file-mention (dsh-file-mention)` 中 `file-mention` 就是 id；括号内是包名）。

2. 带补丁启动：

   ```bash
   dsh web --patch D:\disable-plugin.yml
   ```

3. dsh 正常启动后，再按方法二做永久处理。

**验证技巧**：先 `dsh web --dump-config --patch <文件>` 查看组合树（只打印、不启动），确认目标行带上了 `disabled: true`：

```
# == dsh-file-mention, patched by D:\disable-plugin.yml
- id: file-mention
  name: dsh-file-mention
  disabled: true
```

---

## 方法二：编辑 package.json（永久移除，首选）

这是插件出错的根本原因所在——**bundle 组合列表**。

1. 用任意文本编辑器打开：

   ```
   C:\Users\hu\.dsh\profiles\web\package.json
   ```

2. 在 `dsh.profile.bundles` 数组里**删除出错包所在行**：

   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "@linxin666/dsh-web-ui-all",
         "dsh-file-mention"        ← 删除这一行
       ]
     }
   }
   ```

3. （可选）同时从 `dependencies` 删除对应依赖：

   ```json
   "dependencies": {
     "@linxin666/dsh-web-ui-all": "0.1.10",
     "dsh-file-mention": "file:D:/..."   ← 可选删除
   }
   ```

4. 重新 `dsh web` → 正常启动。

---

## 方法三：彻底清理（卸载）

dsh 正常启动后（或配合方法一），卸载包并清理 node_modules：

```bash
dsh plugin --profile web remove dsh-file-mention
```

> 该命令转发给 pnpm remove，清理依赖与 node_modules；
> 若 `dsh.profile.bundles` 中仍残留该包行，按方法二手动删除。

---

## 预防与自查

| 场景 | 建议 |
|------|------|
| 安装插件前 | `dsh web --dump-config` 查看组合树，确认行 id 与依赖 |
| 升级插件后 | 先 `dsh web --dump-config` 再正式启动 |
| 开发插件 | 先以**动态插件**（`cordis_define`/`cordis_run`）验证：运行时注入、不进 profile 配置，出错 `cordis_undefine` 即可，**永远不会影响 dsh 启动** |
| 写插件 apply | 外部调用尽量 try/catch；启动期不做重活（网络/大文件 IO 放懒加载） |

### 动态插件 vs 正式包（为什么一个永不导致启动失败）

| | 动态插件 | 正式安装包 |
|---|---|---|
| 挂载方式 | 运行时 API 注入（cordis_define/run） | 写入 profile 配置（bundle 组合行） |
| 是否进 profile 配置 | 否 | 是 |
| 出错影响 | 仅该插件失效，可 cordis_undefine | **启动期抛错 → dsh 起不来** |
| 重启后 | 消失（需重新 define） | 常驻 |

---

## FAQ

**Q：插件出错会不会丢数据？**
不会。出错的是插件代码；配置、会话、技能目录都不受影响。

**Q：包文件还在 node_modules 里，删了配置就行？**
对。配置移除后插件不再被组合，node_modules 里的文件可留可清。

**Q：怎么知道出错的组合行 id？**
启动报错信息 `failed to apply loader entry <id> (<包名>)` 里第一个名字就是 id；
也可以 `dsh web --dump-config` 全量查看。

**Q：恢复后还能再装回来吗？**
可以。修复插件代码（或等新版本）后，重新 `dsh plugin --profile web add <包>` 并重启即可。
