# dsh-role-guard

宿主级 **TOOL / MCP / SKILL 权限守卫**，为 DSH 的角色驱动团队委托提供运行时硬性权限执行。

**必须与 [`team-delegate`](../team-delegate) 配套安装**：`team-delegate` 负责派出子代理并在 spawn 后调用 `roleGuard.register(childId, roleName)` 上报角色；本插件负责在宿主 `tools/pre-execute` 瀑布上对带限制的角色子代理**硬拒绝**越权工具调用。

## 它做什么

- 发布 `roleGuard` 宿主服务：`register(childId, roleName)` / `unregister(childId)` / `list()`。
- 每次 `register` 时**实时读取** `$DSH_HOME/agents/<role>.md` 的 frontmatter（不会因为缓存旧配置而失效）。
- 监听宿主根作用域的 `tools/pre-execute`，对已注册且带限制的角色子代理逐条检查：

```
tools: [a, b]        -> 子代理只能调用 a、b（穷尽式白名单；Skill 需显式列入）
disallowedTools: [x] -> 子代理绝不允许调用 x（黑名单，拒绝优先）
mcp_servers: [S]     -> 只允许 mcp__S__* 的 MCP 工具；与 tools 白名单并存时服务器工具加入允许集
skills:             -> (空) 所有 skill 调用被拒绝
skills: [a]          -> 只允许加载技能 a
(未声明该字段)        -> 该维度不受限
```

## 为什么需要它（与 toolFilter 的分工）

`team-delegate` 的 `toolFilter` 是**提示词层面**的软限制（影响子代理"看到"哪些工具）；本插件是**运行时**的硬限制（子代理一旦尝试调用越权工具就被拒绝并收到明确原因）。它挂在宿主作用域，因此覆盖**所有会话、所有预设、前台和后台子代理**——即使有工具在 spawn 之后才注册，也逃不过这道闸。

## 设计说明

- 与 `team-delegate` 共享同一套 Claude Code → DSH 工具名映射，两处不会打架。
- 主代理与未注册角色的内置子代理直接放行，不受影响。
- 最小 frontmatter 解析器与 `team-delegate` 一致；解析失败时按"无限制"处理，不阻塞委托。
- 局限（有意为之）：角色子代理仍能看到完整工具目录，但越权调用会被硬拒绝。

## 安装

复制到 profile 的 `node_modules` 并在 `cordis.patch.yml` 挂载，详见根 [README](../README.md#安装)。

## 配置

```yaml
- id: dsh-role-guard
  name: dsh-role-guard
  config:
    rolesDir: D:\my-roles   # 可选，默认 $DSH_HOME/agents
```

## License

[MIT](../../LICENSE)
