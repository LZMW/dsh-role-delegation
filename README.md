# dsh-role-delegation

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的**角色驱动团队委托**解决方案，包含两个配套的宿主插件，**必须一起安装**：

| 包 | 作用 | 一句话 |
|---|---|---|
| [`team-delegate`](packages/team-delegate) | 派出方 | 提供 `team_delegate` / `team_roles` / `team_find` 三个工具，按角色文件启动类型化子代理，负责模型路由与工具/技能可见性过滤 |
| [`dsh-role-guard`](packages/dsh-role-guard) | 守卫方 | 提供 `roleGuard` 宿主服务，在 `tools/pre-execute` 瀑布上**硬性执行**每个角色的工具/技能权限，兜住后台与所有会话 |

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH Host Process                        │
│                                                              │
│   ┌──────────────────┐     roleGuard.register(childId, role) │
│   │  team-delegate   │ ──────────────────────────────┐       │
│   │  (3 tools)       │                                ▼       │
│   │                  │                    ┌─────────────────┐ │
│   │  spawn child ────┼──────────────────▶ │  dsh-role-guard │ │
│   │  persona+route   │                    │  tools/pre-exec │ │
│   │  +toolFilter     │                    │  ── hard deny   │ │
│   └──────────────────┘                    └─────────────────┘ │
│                                                              │
│   $DSH_HOME/agents/<role>.md   ← 角色定义（frontmatter 控权）  │
└─────────────────────────────────────────────────────────────┘
```

**为什么是两个插件？**

- `team-delegate` 负责「怎么派」：读角色文件、注入 persona、选模型路由、设置子代理的工具可见性（`toolFilter`，软限制，只影响提示词层面）。
- `dsh-role-guard` 负责「派出去之后不能越权」：在宿主作用域拦截每一个工具调用，对带限制的角色**硬拒绝**越权调用。它覆盖所有会话、所有预设、前台和后台子代理——是运行时兜底（`toolFilter` 只能影响子代理"看到"什么，无法阻止其尝试调用）。
- 两者的耦合只有一个点：`team_delegate` 在 spawn 后用 `roleGuard.register(childId, roleName)` 通知守卫。守卫未挂载时 `team-delegate` 完全可用（降级为不限制）。

## 功能特性

- **模型路由**（非阻塞、可用优先）：角色 frontmatter 声明的 `provider`/`model` 优先，未声明时依次回退到配置 `defaultAgentOptions` → 父代理当前实际路由 → 部署默认模型 → 内置兜底。前台委托遇鉴权错误会自动用父路由重试一次。
- **字段级权限控制**（Claude Code 风格，直接写在角色 frontmatter）：
  - `provider` / `model` — 模型路由
  - `tools` — 工具白名单（穷尽式，`Skill` 需显式列入才能用技能工具）
  - `disallowedTools` — 工具黑名单（拒绝优先）
  - `mcp_servers` — MCP 服务器限定（`mcp__<server>__*` 前缀）
  - `skills` — 技能白名单（空列表 = 禁用全部技能；`[a,b]` = 只允许 a、b）
  - **四类全管**：`disallowedTools`（黑名单）、`tools`（白名单）、`mcp_servers`（MCP 前缀）、`skills`（技能）四类按顺序逐条检查，详见 [dsh-role-guard 管控范围](packages/dsh-role-guard#管控范围四类全管)
- **全套团队工具**：`team_delegate`（委托）、`team_roles`（列出角色）、`team_find`（按任务匹配角色）。
- **后台/前台双模式**：默认后台启动返回 durable `subagentId`，可用 `send_message` 继续；`run_in_background: false` 则阻塞等待结果。

## 目录结构

```
dsh-role-delegation/
├── README.md
├── LICENSE
├── packages/
│   ├── dsh-role-guard/     # 守卫插件（roleGuard 服务 + tools/pre-execute 拦截）
│   │   ├── package.json
│   │   └── lib/index.js
│   └── team-delegate/      # 委托插件（team_delegate / team_roles / team_find）
│       ├── package.json
│       ├── index.js        # 入口 shim（兼容不同加载器解析）
│       └── lib/index.js
└── examples/
    └── cordis.patch.yml    # 安装示例（profile 的 cordis.patch.yml）
```

## 安装

DSH 的宿主插件放在 profile 的 `node_modules` 里，通过 `cordis.patch.yml` 挂载。

1. **复制包到 node_modules**（以 `$DSH_HOME/profiles` 为例，路径按你的部署调整）：

   ```powershell
   $dst = "$env:USERPROFILE\.dsh\profiles\node_modules"
   Copy-Item -Recurse packages\dsh-role-guard $dst\
   Copy-Item -Recurse packages\team-delegate $dst\
   ```

2. **在 `cordis.patch.yml` 追加挂载行**（见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)）：

   ```yaml
   - insert:
       - id: dsh-role-guard
         name: dsh-role-guard
   - insert:
       - id: team-delegate
         name: team-delegate
   ```

3. **重启 DSH**，然后用 `team_roles` 验证：应能列出角色文件。

> 两个插件**必须同时安装**：只装 `team-delegate` 时权限守卫不生效（仅提示词层过滤）；只装 `dsh-role-guard` 时没有委托工具。

### 多 profile（web + tui）都支持

DSH 是 **multi-profile** 启动器：`web`（浏览器 GUI）和 `tui`（终端界面）是两个**独立进程**、各自独立的 Cordis 组合，各自读自己的 `cordis.patch.yml`。要让两个界面都用上，**每个 profile 都要挂载这两个插件**：

```powershell
# $DSH_HOME/profiles/web/cordis.patch.yml       ← web 界面
# $DSH_HOME/profiles/<你的-tui-profile>/cordis.patch.yml  ← tui 界面
```

两个 patch 文件内容相同（上文第 2 步的 insert 块）。**插件包只需放一份**在 `$DSH_HOME/profiles/node_modules/`（所有 profile 共享的 flat fallback 层，Node 父目录查找会自动找到），无需每个 profile 单独安装。验证：`dsh --profile <name> --dump-config`，在输出末尾的 `cordis.patch.yml` 段应能看到 `dsh-role-guard` 和 `team-delegate` 两行。

注意：tui 需要真实交互终端（TTY）才能启动；用 `--dump-config` 验证组合树不依赖 TTY。

## 角色文件

角色定义放在 `<项目根>/.dsh/agents/<subagent_type>.md` 或 `$DSH_HOME/agents/<subagent_type>.md`，文件名（不含扩展名）就是 `team_delegate` 的 `subagent_type` 参数，**须为小写字母/数字/连字符**。frontmatter 的正文就是注入给子代理的系统提示词（persona）。

**角色解析优先级**（与 DSH 的 skill 机制一致，多根扫描、首个命中生效）：

1. `config.rolesDir`（显式配置，设置后为唯一根，向后兼容）
2. `<项目根>/.dsh/agents`（项目级，从主代理工作目录向上找 `.git` 定位项目根；无 `.git` 则以工作目录为项目根）
3. `$DSH_HOME/agents`（用户全局）

同名角色**项目级覆盖全局**（如 `team_roles` 只列出一次）。`team-delegate` 会把解析到的角色文件绝对路径传给 `dsh-role-guard`，守卫读取**同一个文件**，两处解析永不打架。

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

你是资深网文校对润色师。职责：
1. ...
```

各字段语义（与 `dsh-role-guard` 完全一致，两处解析逻辑镜像，不会打架）：

| 字段 | 语义 |
|---|---|
| `provider` / `model` | 显式指定模型路由；两者**必须同时出现**才生效 |
| `tools` | 穷尽式白名单；`Skill` 必须列在这里才能调用技能工具；未列出的全部硬拒绝 |
| `disallowedTools` | 黑名单；拒绝优先于白名单 |
| `mcp_servers` | 允许 `mcp__<server>__*`；与 `tools` 白名单并存时服务器工具会被加入允许集 |
| `skills` | 空列表 = 禁用所有技能；`[a]` = 只允许 a（硬拒绝其它技能） |
| 未声明某字段 | 该维度不做限制 |

## 使用方法

```text
# 1. 查看可用角色
team_roles

# 2. 按任务匹配角色
team_find  task: "帮我整理文本里的标点问题"

# 3. 委托（后台，返回 subagentId，可 send_message 继续）
team_delegate  subagent_type: "punctuation-cleaner"
               description: "清理标点"
               prompt: "处理 H:\xxx.md 的标点问题"

# 4. 或前台阻塞等待
team_delegate  subagent_type: "punctuation-cleaner"
               description: "清理标点"
               prompt: "处理 H:\xxx.md 的标点问题"
               run_in_background: false
```

## 模型路由优先级（team-delegate）

1. 角色 frontmatter `provider` + `model`（两者都有才生效）
2. 配置 `defaultAgentOptions`（管理员显式覆盖）
3. 父代理当前实际路由（从最近一次 `request/context` 事件读取）
4. `agentDefaultModel.currentSelection()`（部署默认模型）
5. 内置兜底 `{ provider: 'huoshan', model: 'deepseek-v4-flash' }`

前台委托在遭遇鉴权类错误（401/403/无效密钥/额度不足等）时会用父代理路由自动重试一次；后台委托无自动重试。

## 配置

两个插件都支持 `rolesDir`（角色目录，默认 `$DSH_HOME/agents`）；`team-delegate` 额外支持 `defaultAgentOptions`。示例：

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
