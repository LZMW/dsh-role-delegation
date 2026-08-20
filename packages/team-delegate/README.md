# team-delegate

面向 DSH 的**角色驱动团队委托**插件：读取 `<项目根>/.dsh/agents/<subagent_type>.md` 或 `$DSH_HOME/agents/<subagent_type>.md` 角色定义（项目级优先），把该文件正文作为子代理的系统提示词（persona）注入，启动类型化子代理。

**必须与 [`dsh-role-guard`](../dsh-role-guard) 配套安装**：本插件负责派出子代理与模型路由；`dsh-role-guard` 负责在宿主层硬性执行角色的工具/技能权限。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `team_delegate` | 委托给一个类型化团队成员子代理。参数：`subagent_type`（角色键）、`description`、`prompt`（任务本身）、`run_in_background`（默认 true） |
| `team_roles` | 列出所有可用角色及其 frontmatter（provider/model/工具/技能控制），从项目级与全局目录汇总（项目级优先，同名字只出现一次） |
| `team_find` | 按任务描述自动匹配最合适的角色（分词打分，返回排序候选） |

## 模型路由优先级（非阻塞、可用优先）

1. 角色 frontmatter `provider` + `model`（**两者必须同时出现**才生效）
2. 配置 `defaultAgentOptions`（管理员显式覆盖）
3. 父代理当前实际路由（最近一次 `request/context` 事件）
4. `agentDefaultModel.currentSelection()`（部署默认模型）
5. 内置兜底 `{ provider: 'huoshan', model: 'deepseek-v4-flash' }`

前台委托（`run_in_background: false`）在遭遇鉴权类错误（401/403/无效密钥/额度不足/无权限等）时，会用父代理路由自动重试一次。后台委托无自动重试。

## 角色发现（多根，与 skill 同机制）

角色文件放在 `<项目根>/.dsh/agents/<subagent_type>.md` 或 `$DSH_HOME/agents/<subagent_type>.md`，文件名须为小写字母/数字/连字符。解析优先级：

1. `config.rolesDir`（显式配置，设置后为唯一根，向后兼容）
2. `<项目根>/.dsh/agents`（从主代理工作目录向上找 `.git` 定位项目根；无 `.git` 则以工作目录为项目根）
3. `$DSH_HOME/agents`（用户全局）

同名角色**项目级覆盖全局**。解析到的角色文件绝对路径会传给 `dsh-role-guard`，守卫读取同一文件。示例：

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

`team-delegate` 会把这些字段翻译成子代理的 `toolFilter`（内部调用 `tools.restrict()`，注册表层硬执行——白名单外工具子代理调不到，会报 `UNKNOWN_TOOL`）和技能提示词。工具名会对照**主代理可见视图**校验存在性（含 preset 层工具；平台差异如 macOS 的 `Bash`→`bash` 自动适配）。若某个工具在子代理视图里实际不存在导致 `restrict()` 拒绝，委托会自动**去掉 toolFilter 重试**并提示告警，而不是整体失败。

> 💡 **frontmatter 支持 YAML 块状列表和行内注释**（与 `dsh-role-guard` 相同的解析方言）：
> ```yaml
> tools:
>   - read
>   - write
> skills:
>   - proofreader   # 行内注释也会被正确剥离
> ```
> 等价于 `tools: [read, write]`、`skills: [proofreader]`。

## 入口

`lib/index.js` 导出 `{ Config, apply, inject, name }`（Cordis 宿主插件标准形态）。根目录 `index.js` 是入口 shim，兼容不同加载器对裸包名的解析，从 `lib` 再导出。

## 安装

复制到 profile 的 `node_modules` 并在 `cordis.patch.yml` 挂载，详见根 [README](../README.md#安装)。

## 配置

```yaml
- id: team-delegate
  name: team-delegate
  config:
    rolesDir: D:\my-roles          # 可选；设置后为唯一角色根（覆盖项目级+全局）
    defaultAgentOptions:           # 可选，路由优先级 2
      provider: my-provider
      model: my-model
```

## License

[MIT](../../LICENSE)
