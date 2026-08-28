# dsh-role-delegation

**给 DeepSeek Harness (DSH) 加一个"专家团队"**：你定义一堆各有专长、各有权限的角色文件，然后一句 `team_delegate` 把任务派给合适的专家——它自动用对的模型、只带允许的工具和技能，干完把结果交回来。

> 一句话：**把"我该自己干"变成"我派专家干"，每个专家还被关在它该待的权限笼子里。**

---

## 这是什么 / 解决什么

用 DSH 干活时，你会发现有些任务适合"拆给专门的子代理"：比如写作、看代码、查资料、清理标点——每个都可以是一个"专家"。但自己手动管理一堆子代理很痛苦：

| 没有本插件时 | 有这个插件后 |
|---|---|
| 每个子代理要手动指定模型、手动约束它能用哪些工具 | 角色文件里写死，委托时自动套用 |
| 子代理能乱调工具、乱加载技能（越权） | 白名单外的东西**根本看不见、也调不动** |
| 没有"专家清单"，全靠主代理临场拼 prompt | `team_roles` 列出所有专家，`team_find` 按任务自动匹配 |
| 后台长任务难管理 | 后台启动返回 `subagentId`，随时 `send_message` 续派 |

**核心能力**：
- **角色驱动的委托**：一个 `.md` 文件 = 一个专家（persona + 模型 + 工具/技能/MCP 权限白名单）
- **权限真正落地**：白名单外的工具、技能、MCP 服务器，对子代理**不可见、不可调用**（不是"看得到但被拦"）
- **后台/前台双模式**：默认后台异步，返回 id 可续派；需要时前台阻塞等结果
- **web + tui 双界面**都可用

---

## 快速开始（3 步）

### 1. 安装两个包

把 `packages/` 下的两个目录复制到 DSH 的共享 node_modules（所有 profile 共用）：

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\node_modules"
Copy-Item -Recurse packages\dsh-role-guard $dst\
Copy-Item -Recurse packages\team-delegate $dst\
```

### 2. 挂载到 profile

在你用的每个 profile 的 `cordis.patch.yml` 里追加（web、tui 各一份）：

```yaml
- insert:
    - id: dsh-role-guard
      name: dsh-role-guard
- insert:
    - id: team-delegate
      name: team-delegate
```

> ⚠️ 两个插件**必须一起装**：只装 `team-delegate` 没权限守卫；只装 `dsh-role-guard` 没有委托工具。

### 3. 建一个角色，然后派活

角色就是一个 markdown 文件，放在 `<项目根>/.dsh/agents/` 或 `$DSH_HOME/agents/`：

```markdown
---
name: 标点清理师
description: Use this agent when you need to clean punctuation in Chinese web-novel text.
provider: deepseek-official
model: deepseek-v4-pro
tools: [read, write, edit, glob, grep, skill]
skills: [novel-punctuation-cleaner]   # 只能加载这一个技能
disallowedTools: [web_search]         # 禁止联网搜索
---

你是资深网文标点清理师。逐章阅读、逐处判断、用 Edit 修改：
1. 破折号按语境改逗号/冒号/省略号
2. 删除独立成段的场景分隔符
3. 全角括号（）替换为「」
```

然后交给主代理一句话，它就会派出这个专家：

```text
team_delegate  subagent_type: "标点清理师"
               description: "清理标点"
               prompt: "处理 H:\xxx.md 的标点问题"
```

搞定。专家只带白名单工具、只加载允许的技能、用指定的模型，干完交结果。

---

## 角色文件（核心概念）

**一个角色 = 一个 `.md` 文件**，文件名（不含扩展名）就是 `subagent_type`，正文就是注入给子代理的"人设"（persona）。

**frontmatter 控制一切**：

| 字段 | 作用 |
|---|---|
| `provider` / `model` | 指定模型路由（两者必须同时写才生效） |
| `tools` | 工具白名单（穷尽式）；没列的一律不可见 |
| `disallowedTools` | 工具黑名单（拒绝优先） |
| `mcp_servers` | 允许哪些 MCP 服务器（`mcp__<server>__*`） |
| `skills` | 技能白名单；`[]` 禁全部技能，`[a,b]` 只允许 a、b |
| 不写某个字段 | 该维度不限制 |

**角色放哪**（同名时项目级覆盖全局）：
1. `config.rolesDir`（显式配置）
2. `<项目根>/.dsh/agents`
3. `$DSH_HOME/agents`

**模型路由优先级**（没在角色里写 model 时）：角色 frontmatter → 配置 `defaultAgentOptions` → 父代理当前实际路由 → 部署默认模型 → 内置兜底。前台委托遇鉴权错误会自动用父路由重试一次。

---

## 常用操作

```text
# 看看有哪些专家
team_roles

# 按任务自动匹配专家
team_find  task: "帮我整理文本里的标点问题"

# 委托（后台异步，返回 subagentId，可用 send_message 续派）
team_delegate  subagent_type: "标点清理师"
               description: "清理标点"
               prompt: "处理 H:\xxx.md 的标点问题"

# 或前台阻塞等结果
team_delegate  subagent_type: "标点清理师"
               description: "清理标点"
               prompt: "处理 H:\xxx.md 的标点问题"
               run_in_background: false
```

---

## 为什么是两个插件（想了解实现再看）

| 包 | 角色 | 一句话 |
|---|---|---|
| [`team-delegate`](packages/team-delegate) | 派出方 | 提供 `team_delegate`/`team_roles`/`team_find`，按角色文件启动子代理，负责模型路由与工具/技能可见性过滤 |
| [`dsh-role-guard`](packages/dsh-role-guard) | 守卫方 | 在宿主层**硬性执行**每个角色的权限，兜住后台与所有会话 |

`team-delegate` 负责"怎么派"（读角色、注入 persona、选模型、限制可见性）；`dsh-role-guard` 负责"怎么防"（在 `tools/pre-execute` 上做参数级 skill 白名单、MCP 前缀准入、黑名单优先、跨作用域兜底）。两者的耦合只有一处：委托后用 `roleGuard.register(childId, roleName, rolePath)` 通知守卫。守卫未挂载时 `team-delegate` 仍可用（降级为软白名单）。

## 目录结构

```
dsh-role-delegation/
├── packages/
│   ├── dsh-role-guard/     # 守卫插件
│   └── team-delegate/      # 委托插件
└── examples/
    └── cordis.patch.yml    # 安装示例
```

## 配置

两个插件都支持 `rolesDir`（角色目录，默认 `$DSH_HOME/agents`）；`team-delegate` 额外支持 `defaultAgentOptions`：

```yaml
- id: team-delegate
  name: team-delegate
  config:
    rolesDir: D:\my-roles
    defaultAgentOptions:
      provider: my-provider
      model: my-model
```

## License

[MIT](LICENSE)
