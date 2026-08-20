# team-delegate

面向 DSH 的**角色驱动团队委托**插件：读取 `$DSH_HOME/agents/<subagent_type>.md` 角色定义，把该文件正文作为子代理的系统提示词（persona）注入，启动类型化子代理。

**必须与 [`dsh-role-guard`](../dsh-role-guard) 配套安装**：本插件负责派出子代理与模型路由；`dsh-role-guard` 负责在宿主层硬性执行角色的工具/技能权限。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `team_delegate` | 委托给一个类型化团队成员子代理。参数：`subagent_type`（角色键）、`description`、`prompt`（任务本身）、`run_in_background`（默认 true） |
| `team_roles` | 列出 `$DSH_HOME/agents` 下所有角色及其 frontmatter（provider/model/工具/技能控制） |
| `team_find` | 按任务描述自动匹配最合适的角色（分词打分，返回排序候选） |

## 模型路由优先级（非阻塞、可用优先）

1. 角色 frontmatter `provider` + `model`（**两者必须同时出现**才生效）
2. 配置 `defaultAgentOptions`（管理员显式覆盖）
3. 父代理当前实际路由（最近一次 `request/context` 事件）
4. `agentDefaultModel.currentSelection()`（部署默认模型）
5. 内置兜底 `{ provider: 'huoshan', model: 'deepseek-v4-flash' }`

前台委托（`run_in_background: false`）在遭遇鉴权类错误（401/403/无效密钥/额度不足/无权限等）时，会用父代理路由自动重试一次。后台委托无自动重试。

## 字段级控制（角色 frontmatter）

角色文件放在 `$DSH_HOME/agents/<subagent_type>.md`，文件名须为小写字母/数字/连字符。示例：

```markdown
---
name: 校对润色师
description: Use this agent when you need to polish, proofread or refine prose.
provider: deepseek-official
model: deepseek-v4-pro
tools: [read, write, edit, glob, grep, pwsh]
disallowedTools: [web_search]
mcp_servers: []
skills: [novel-punctuation-cleaner]
---

你是资深网文校对润色师。职责：...
```

`team-delegate` 会把这些字段翻译成子代理的 `toolFilter`（软限制，影响提示词可见性）和技能提示词；**硬性执行由 `dsh-role-guard` 完成**。

## 入口

`lib/index.js` 导出 `{ Config, apply, inject, name }`（Cordis 宿主插件标准形态）。根目录 `index.js` 是入口 shim，兼容不同加载器对裸包名的解析，从 `lib` 再导出。

## 安装

复制到 profile 的 `node_modules` 并在 `cordis.patch.yml` 挂载，详见根 [README](../README.md#安装)。

## 配置

```yaml
- id: team-delegate
  name: team-delegate
  config:
    rolesDir: D:\my-roles          # 可选，默认 $DSH_HOME/agents
    defaultAgentOptions:           # 可选，路由优先级 2
      provider: my-provider
      model: my-model
```

## License

[MIT](../../LICENSE)
