# dsh-role-guard

宿主级 **TOOL / MCP / SKILL 权限守卫**，为 DSH 的角色驱动团队委托提供运行时硬性权限执行。

**必须与 [`team-delegate`](../team-delegate) 配套安装**：`team-delegate` 负责派出子代理并在 spawn 后调用 `roleGuard.register(childId, roleName, rolePath)` 上报角色（`rolePath` 是解析胜出的角色文件绝对路径，支持项目级 `.dsh/agents` 角色）；本插件负责在宿主 `tools/pre-execute` 瀑布上对带限制的角色子代理**硬拒绝**越权工具调用。

## 它做什么

- 发布 `roleGuard` 宿主服务：`register(childId, roleName, rolePath?)` / `unregister(childId)` / `list()`。
- 每次 `register` 时**实时读取**角色 frontmatter（不会因为缓存旧配置而失效）。传入 `rolePath` 时读取**该文件**（与 `team-delegate` 解析到的完全一致，项目级/全局都支持）；未传时回退到自身 `rolesDir` 解析。
- 监听宿主根作用域的 `tools/pre-execute`，对已注册且带限制的角色子代理逐条检查：

```
tools: [a, b]        -> 子代理只能调用 a、b（穷尽式白名单；Skill 需显式列入）
disallowedTools: [x] -> 子代理绝不允许调用 x（黑名单，拒绝优先）
mcp_servers: [S]     -> 只允许 mcp__S__* 的 MCP 工具；与 tools 白名单并存时服务器工具加入允许集
skills:             -> (空) 所有 skill 调用被拒绝
skills: [a]          -> 只允许加载技能 a
(未声明该字段)        -> 该维度不受限
```

## 管控范围（四类全管）

`dsh-role-guard` 管**四类字段**，在 `tools/pre-execute` 瀑布上按顺序逐条检查，全部通过才放行（`report` 机制工具无条件豁免，见下文）：

| # | 字段 | 管什么 | 语义 |
|---|---|---|---|
| 1 | `disallowedTools` | 工具黑名单 | 命中即拒绝，**优先级最高**，无条件生效 |
| 2 | `tools` / `mcp_servers` | 工具白名单 + MCP 前缀 | `tools` 穷尽式白名单；`mcp_servers: [S]` 放行 `mcp__S__*` 一类前缀；两者并存时服务器工具并入允许集 |
| 3 | `skills` | 技能白名单 | 最后一个维度；`skills: []` 拒绝所有技能，`[a]` 只允许 a |

```js
// 1. disallowedTools — 黑名单（拒绝优先）
if (info.denyTools.has(name)) return deny('this role is not allowed to use: ' + name)

// 2. tools 白名单（穷尽式）+ mcp_servers 前缀控制
//    普通工具 → 白名单为 null 或包含它才放行
//    MCP 工具 → 有 mcp_servers 时只放行 mcp__<server>__*（并并入 tools 显式列出的）；
//               无 mcp_servers 时仅白名单显式列出的 MCP 工具才放行

// 3. skills 技能白名单（最后一个维度；必须先过第 2 步工具白名单）
if (name === 'skill' && info.skillsDeclared) {
  // skills: []  → 拒绝所有技能加载
  // skills: [a] → 只允许加载技能 a
}
```

> ⚠️ **技能要放行，必须先过第 2 步的工具白名单**：角色若写了 `tools:`，必须把 `Skill` 也列进去，否则技能工具在第 2 步就被拦了。

> 💡 一句话：`dsh-role-guard` 管 **`disallowedTools`（黑名单）、`tools`（白名单）、`mcp_servers`（MCP 前缀）、`skills`（技能）** 四类——skill 只是其中最后一类。

## 为什么需要它（与 toolFilter 的分工）

`team-delegate` 的 `toolFilter`（内部 `tools.restrict()`）是**注册表层**的硬执行——子代理调不到白名单外工具（`UNKNOWN_TOOL`），限制持续整个生命周期。但 `restrict()` 有它够不到的增量，正是本插件补上的：

1. **skill 参数级白名单**：`restrict()` 只能整体禁/放 `skill` 工具；本插件能检查 `skill` 的 `arguments.name`，做到"只允许加载技能 A"。
2. **MCP 服务器前缀动态准入**：`restrict()` 是 spawn 时快照；本插件每次调用按 `mcp__<server>__*` 实时判定。
3. **`disallowedTools` 黑名单优先序**：deny 先于任何 allow 判定。
4. **跨作用域兜底**：宿主根作用域覆盖所有会话/预设/前台/后台子代理（含 spawn 后才注册的工具）。

**机制工具豁免**：continuable 子代理被系统提示词要求用 `report` 工具汇报结果（它属于子代理自身层，DSH 的 `restrict()` 对此豁免）。本插件同样豁免 `report`——白名单/黑名单都不会破坏子代理的汇报通道。

> 💡 **frontmatter 支持 YAML 块状列表和行内注释**（与 `team-delegate` 相同的解析方言）：
> ```yaml
> tools:
>   - read
>   - write
> disallowedTools:
>   - web_search   # 行内注释正确剥离
> ```

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
    rolesDir: D:\my-roles   # 可选；仅当 team-delegate 未传 rolePath 时作为回退根
```

## License

[MIT](../../LICENSE)
