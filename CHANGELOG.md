# Changelog

## 1.2.0

第三方审查（静态对照 + 解析器实测）后的一轮修复：

### 修复（高危）

- **块状 YAML 列表静默失效（Bug 3）**：frontmatter 解析器此前只认 `key: value` 单行，`tools:`/`skills:` 后跟缩进的 `- item` 块状列表会被静默解析为空——`tools` 方向丢权限（完全放行）、`skills` 方向反向禁用（全部技能被禁），且无告警。两个插件现在都支持 YAML 块状列表和行内注释剥离（解析方言逐字镜像，两处永不打架）。
- **后台子代理汇报通道被白名单硬拒（Bug 2）**：continuable 子代理被系统提示词要求用 `report` 工具汇报结果，但 guard 的白名单一视同仁，导致后台角色不写 `report` 就汇报失败、反复重试烧 turn。现在 `report` 作为子代理自身层的机制工具**无条件豁免**（与 DSH `restrict()` 的 own-layer 豁免语义一致）。
- **工具存在性校验视图错误（Bug 1）**：`mapToolName` 此前用 `ctx.tools.get()`（全局视图）判断工具是否存在，而 preset 层工具不在全局视图 → 被误判"不存在"而静默丢弃（macOS 上 `Bash` 角色直接断链）；`KNOWN_DSH_TOOLS` 无条件保留又会让 `restrict()` 抛 unknown-tool。现在存在性校验改用**主代理可见视图**（含 preset 层），平台差异自动适配；若仍触发 `restrict()` 拒绝，委托自动**去掉 toolFilter 重试**并告警，不再整体失败。

### 修复（中等）

- **前台 `run.result` reject 绕过错误路径（Bug 7）**：子代理 run promise 被拒（基础设施错误）时会直接抛出，跳过鉴权重试和结构化错误。现在规范化为 `stopReason: 'error'`，走正常的错误/重试路径。
- **guard 注册表泄漏（Bug 6 前台部分）**：前台一次性子代理 dispose 后 unregister 其守卫表项。
- **驼峰变体不一致（Bug 9）**：`disallowed_tools` / `mcpServers` 变体此前只在 `team_roles` 展示层生效、执行层不认。现在执行两层（delegate + guard）都认这些别名。
- **列出非法角色名（Bug 10）**：`team_roles` / `team_find` 现在过滤不合 `subagent_type` 命名规则（小写字母/数字/连字符）的文件，避免列出 `team_delegate` 会拒绝的角色。
- **前台返回值 `runId` 语义滥用（Bug 11）**：此前 `runId` 字段塞的是 `provider/model` 路由字符串，名不符实。现改为结构化 `route: { provider, model }` 字段，`runId` 移除。
- **会话事件全量扫描（Bug 12）**：`parentRoute` 改为从事件尾部倒序找最近一条 `request/context`（长会话 O(最近) 而非 O(全历史)）；`dumpChildEvents` 只 dump 尾部 200 条事件窗口。

### 文档

- 更正双插件分工叙述：`toolFilter`（`restrict()`）是**注册表层硬执行**而非"提示词软限制"；`dsh-role-guard` 的真实增量是 skill 参数级白名单、MCP 动态准入、deny 优先序与跨作用域兜底。

### 已知取舍（有意为之，非 bug）

- 守卫在角色文件缺失/不可读时按"无限制"注册（fail-open）——保证"缺 guard/缺文件不阻塞委托"。
- 后台子代理的守卫注册表是内存态，进程重启后丢失（后台冷恢复的子代理失去 guard 强制，仅剩 `restrict()` 层）。
