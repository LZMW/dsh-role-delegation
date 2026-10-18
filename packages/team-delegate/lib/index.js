// team-delegate: role-directed team delegation for DSH.
//
// Role discovery (ordered roots, first match wins):
//   1. config.rolesDir               (explicit admin root, single root if set)
//   2. <projectRoot>/.dsh/agents     (project-local, resolved from the calling
//                                     agent's cwd walking up to a .git, same
//                                     mechanism DSH uses for project skills)
//   3. $DSH_HOME/agents              (user-global)
// Each <subagent_type>.md body becomes the spawned subagent's system prompt
// (persona). The same root resolution is mirrored by dsh-role-guard so the
// guard enforces the exact winning role file.
//
// Model-route selection (priority, "usable and non-blocking"):
//   1. role frontmatter `provider` + `model`   (explicit per-role choice)
//   2. config `defaultAgentOptions`            (explicit admin override)
//   3. the parent agent's CURRENT actual route (last session `request/context`)
//   4. ctx.agentDefaultModel.currentSelection() (deployment default, live settings)
//   5. built-in fallback
//
// Field-based controls (Claude Code style, enforced on the child):
//   `tools:`            -> tool restriction allow (hard whitelist; unknown names skipped+warned)
//   `disallowedTools:`  -> tool restriction deny  (hard blacklist)
//   `mcp_servers: [X]`  -> expand to mcp__X__* (allow if `tools:` present, else deny all
//                          MCP tools outside the listed servers)
//   `skills:`           -> [] => skill tool denied (hard); [a,b] => prompt-level whitelist (soft)
// Names are mapped from Claude Code to DSH; MCP tool names pass through as-is.
//
// DSH 0.2.1 composition model (why the code below looks the way it does)
//   0.2.1 replaced `ctx.subagents.start` / `startContinuable` with the single
//   `startActivation({ provider, label, childId?, request, signal, delivery })`,
//   and it removed `request.persona` / `request.toolFilter`: a child's persona
//   and tool composition now belong to an Agent Preset. A role file is still a
//   per-delegation composition, so this plugin applies it on the CHILD's own
//   scope the moment the child is created (`agent/created`), before its first
//   step assembles the system prompt and requests tool schemas:
//     - role body  -> a scoped `systemPrompt.section` (same position as the
//                     deployment persona)
//     - tools/mcp  -> `tools.restrict` on the child registry
//     - skills     -> `tools.guard` on the child registry (call-time deny)
//   The child id is reserved by the caller (`startActivation({ childId })`), so
//   the pending table is keyed before the child exists and the host-level
//   `dsh-role-guard` can be told the role BEFORE the child can call a tool.
//   Foreground runs use `delivery: 'caller'` (result returned, no parent
//   message); background runs use `delivery: 'parent'` (the runtime delivers
//   the settlement notice to the calling agent).

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

const name = 'team-delegate'
const inject = ['tools', 'subagents']
const ROLE_NAME = /^[a-z0-9-]+$/
// Role persona section name/order. `deployment:persona-prefix` is order 0, so
// order 1 keeps the role body right after the deployment persona without ever
// colliding with a preset-owned section name.
const ROLE_SECTION = 'team-delegate:role'
const ROLE_SECTION_ORDER = 1
const FALLBACK_AGENT_OPTIONS = { provider: 'huoshan', model: 'deepseek-v4-flash' }
const AUTH_HINT = /auth|authentication|api key|invalid key|401|403|insufficient|quota|balance|permission|无权限|鉴权|密钥/i

// Claude Code tool name -> DSH candidate names (all are real DSH tool names; the
// known-set filter keeps the ones that exist on this platform, e.g. bash vs pwsh).
// Names not in this map pass through as-is (a DSH tool name or an mcp__* name).
const TOOL_NAME_MAP = {
  read: ['read'],
  write: ['write'],
  edit: ['edit'],
  glob: ['glob'],
  grep: ['grep'],
  bash: ['bash', 'pwsh'],
  websearch: ['web_search'],
  skill: ['skill'],
  todowrite: ['todo_write'],
  askuserquestion: ['ask_user_question'],
  task: ['subagent'],
  readimage: ['read_image'],
  exitplanmode: ['exit_plan_mode'],
  lsp: [],
  webfetch: [],
  notebookedit: [],
  multiedit: ['edit'],
  getgoal: ['get_goal'],
  web: ['web_search']
}

// Known DSH model-facing tool names used to validate mapped allow/deny entries.
// The dynamic sandbox cannot query the registry (`ctx.tools.get` is not exposed
// there), so validation is static; `mcp__*` names pass through by prefix. Note:
// `bash` is NOT listed because it is disabled on Windows (only `pwsh` exists);
// mapping `Bash` yields ['bash','pwsh'] and the surviving name is kept.
const KNOWN_DSH_TOOLS = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'skill',
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph', 'job_output', 'job_list', 'job_kill', 'create_goal', 'get_goal',
  'update_goal', 'ask_user_question', 'todo_write', 'read_image', 'exit_plan_mode',
  'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'cordis_inspect_list',
  'cordis_inspect_query', 'cordis_inspect_self', 'team_delegate', 'team_roles', 'team_find'
])

const Config = z.object({
  rolesDir: z.string().default(''),
  defaultAgentOptions: z.object({
    provider: z.string(),
    model: z.string()
  }).default(undefined)
})

// The parent agent's absolute working directory (SessionHeader.cwd), if any.
function agentCwd(agent) {
  try {
    const header = agent && agent.session ? agent.session.header : undefined
    return header && typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  } catch {
    return undefined
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Mirror DSH skill discovery: the project root is the nearest ancestor of cwd
// that contains a .git directory, falling back to cwd itself.
async function findProjectRoot(cwd) {
  let current = cwd
  for (;;) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

// Ordered role roots, highest priority first. An explicit config.rolesDir wins
// as the single root (backward compatible); otherwise project-local
// <projectRoot>/.dsh/agents precedes the global $DSH_HOME/agents — the same
// precedence DSH uses for project vs user skills.
async function roleRoots(config, agent) {
  if (config && typeof config.rolesDir === 'string' && config.rolesDir.length > 0) {
    return [resolve(config.rolesDir)]
  }
  const roots = []
  const cwd = agentCwd(agent)
  if (cwd) {
    const projectRoot = await findProjectRoot(cwd)
    roots.push(join(projectRoot, '.dsh', 'agents'))
  }
  roots.push(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agents'))
  return roots
}

function findClosingFrontmatter(text, start) {
  let i = start
  while (i <= text.length) {
    const nl = text.indexOf('\n', i)
    const lineEnd = nl < 0 ? text.length : nl
    if (text.slice(i, lineEnd).replace(/\r$/, '') === '---') return i
    if (nl < 0) return -1
    i = nl + 1
  }
  return -1
}

// Strip an unquoted, outside-bracket YAML inline comment (` # ...`), so
// `tools: [read, write] # 白名单` yields only the list. A `#` inside quotes or
// brackets is data. Returns the cleaned line (trimmed).
function stripInlineComment(line) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '[' || ch === '{') { depth++; continue }
    if (ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue }
    if (ch === '#' && depth === 0) return line.slice(0, i).trim()
  }
  return line.trim()
}

// Parse role frontmatter as a small YAML subset. Besides plain `key: value`
// lines it supports YAML block lists (`key:` followed by indented `- item`
// lines) and inline comments. A list field yields a string[] (or '' when the
// key is present with no value); scalar fields yield strings.
function parseFrontmatterMeta(frontmatter) {
  const lines = frontmatter.split('\n')
  const meta = {}
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i])
    if (!line || line === '---') continue
    const m = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = (m[2] === undefined ? '' : m[2]).replace(/^['"]|['"]$/g, '').trim()
    // Block list: the key line has no inline value and the following lines are
    // `- item` entries indented deeper than the key. Indentation is measured on
    // the RAW line (stripInlineComment trims, which would erase it).
    if (value === '') {
      const indent = /^[ \t]*/.exec(lines[i])[0].length
      const items = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const rawNext = lines[j]
        const rawIndent = /^[ \t]*/.exec(rawNext)[0].length
        const next = stripInlineComment(rawNext)
        if (!next) continue
        if (next.startsWith('-')) {
          if (rawIndent <= indent) break
          items.push(next.replace(/^[ \t]*-\s*/, '').replace(/^['"]|['"]$/g, '').trim())
          continue
        }
        if (/^[ \t]*[A-Za-z0-9_-]+:/.test(next) && rawIndent <= indent) break
        break
      }
      if (items.length > 0) {
        meta[key] = items
        i = j - 1
        continue
      }
    }
    meta[key] = value
  }
  return meta
}

function parseRole(raw) {
  const text = String(raw)
  const firstNL = text.indexOf('\n')
  if (firstNL < 0 || text.slice(0, firstNL).replace(/\r$/, '') !== '---') {
    return { body: text.trim(), meta: {} }
  }
  const closing = findClosingFrontmatter(text, firstNL + 1)
  if (closing < 0) return { body: text.trim(), meta: {} }
  const frontmatter = text.slice(firstNL + 1, closing)
  const body = text.slice(closing + 3).replace(/^\r?\n/, '').trim()
  return { body, meta: parseFrontmatterMeta(frontmatter) }
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

function blockText(blocks) {
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

// Read a session's event log across DSH versions. 0.1.5 removed the public
// `events` array accessor on Session (replaced by snapshotEvents() /
// ownEvents() / eventAt()); reading `session.events` there yields undefined,
// which silently broke parent-route recovery and child-event diagnostics.
// Prefer the 0.1.5 public API, fall back to the legacy accessor for older
// versions.
function sessionEvents(session) {
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    }
  } catch {}
  return session && Array.isArray(session.events) ? session.events : []
}

// The parent agent's CURRENT actual route, read from its last session
// `request/context` event (records what each real request used after the
// agent/request waterfall, unlike the possibly-stale `options`). Scanned from
// the TAIL so a long session is O(latest) not O(whole history).
function parentRoute(agent) {
  if (!agent) return undefined
  try {
    const events = sessionEvents(agent.session)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const d = ev && ev.data ? ev.data : {}
      if (ev && ev.type === 'request/context' && typeof d.provider === 'string' && d.provider.length > 0 && typeof d.model === 'string' && d.model.length > 0) {
        return { provider: d.provider, model: d.model }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

// Diagnostics: dump the settled child's session events to find the real failure.
// Only the TAIL of the log is dumped (maxLen output cap + a bounded event
// window) — the failure surface is always near the end, so a long-running
// child does not force a full-history scan per delegation.
function dumpChildEvents(child, maxLen) {
  if (!child) return ''
  try {
    const events = sessionEvents(child.session)
    const start = Math.max(0, events.length - 200)
    const out = []
    for (let i = start; i < events.length; i++) {
      const ev = events[i]
      const d = ev && ev.data ? ev.data : {}
      const brief = {}
      if (ev && ev.type) brief.t = ev.type
      if (typeof d.message === 'string' && d.message.length > 0) brief.msg = String(d.message).slice(0, 500)
      if (d.reason !== undefined && d.reason !== null) {
        try { brief.r = JSON.stringify(d.reason).slice(0, 800) } catch { brief.r = '?' }
      }
      if (d.provider || d.model) brief.route = JSON.stringify({ provider: d.provider, model: d.model })
      if (typeof d.level === 'string') brief.lv = d.level
      if (typeof d.kind === 'string') brief.k = d.kind
      out.push(JSON.stringify(brief))
    }
    return out.join('\n').slice(0, maxLen)
  } catch (e) {
    return '[dump failed: ' + String(e) + ']'
  }
}

function sameRoute(a, b) {
  return !!(a && b && a.provider === b.provider && a.model === b.model)
}

function looksLikeAuth(result, dump) {
  if (result.stopReason !== 'error') return false
  const text = (dump || '') + '\n' + blockText(result.output || [])
  return AUTH_HINT.test(text)
}

// ── role matching (team_find) ──────────────────────────────────────────────
function tokenize(text) {
  const counts = new Map()
  const s = String(text).toLowerCase()
  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length < 2) continue
    counts.set(m[0], (counts.get(m[0]) || 0) + 1)
  }
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, '')
  const push = (t) => counts.set(t, (counts.get(t) || 0) + 1)
  if (cjk.length === 1) push('c:' + cjk)
  for (let i = 0; i < cjk.length - 1; i++) push('c:' + cjk.slice(i, i + 2))
  return counts
}

function tokenWeight(counts) {
  let sum = 0
  for (const v of counts.values()) sum += v
  return sum
}

function scoreTask(taskCounts, roleCounts) {
  let overlap = 0
  for (const [k, v] of roleCounts) {
    const tv = taskCounts.get(k)
    if (tv !== undefined) overlap += Math.min(v, tv)
  }
  if (overlap === 0) return 0
  const n1 = tokenWeight(taskCounts)
  const n2 = tokenWeight(roleCounts)
  return overlap / Math.sqrt(n1 * n2)
}

// ── field-based controls ───────────────────────────────────────────────────
function parseListField(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  return String(value).replace(/[[\]{}]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
}

// Normalize a frontmatter list field to a display string (block lists parse to
// string[]; inline lists to a bracketed string). team_roles presents them as
// strings.
function stringifyList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ')
  return String(value === undefined ? '' : value).replace(/[[\]{}]/g, '').trim()
}

// Map one role frontmatter tool name to the DSH tool names that ACTUALLY exist
// in the parent agent's visible view (global + ancestor/preset layers — the
// child inherits exactly this surface). Existence is decided by the live view,
// not a static set: a static whitelist both drops preset-level tools that are
// real but not in the global layer, and keeps names that do not exist on this
// platform (which would make tools.restrict() throw). `parent` may be absent
// (non-agent callers) — then only globally visible tools are accepted.
function mapToolName(rawName, ctx, parent, parentVisible) {
  const key = rawName.toLowerCase().replace(/[\s_-]/g, '')
  const candidates = Object.prototype.hasOwnProperty.call(TOOL_NAME_MAP, key) ? TOOL_NAME_MAP[key] : [rawName]
  const visible = parentVisible || (() => {
    try {
      const set = new Set()
      for (const s of ctx.tools.schemas(parent)) if (s && s.name) set.add(s.name)
      return set
    } catch {
      return null
    }
  })()
  return candidates.filter((c) => {
    if (typeof c === 'string' && c.startsWith('mcp__')) return true
    if (visible === null) return KNOWN_DSH_TOOLS.has(c)
    return visible.has(c)
  })
}

// Build the child's tool restriction + skill prompt from role frontmatter fields.
// `skills:` empty -> deny the `skill` tool (the child sees no skills at all).
// `skills: [a,b]` -> keep the `skill` tool but a per-child guard (installed in
// `agent/created`) hard-denies calls for names outside the whitelist with a clear reason.
function buildRoleControls(role, ctx, parent) {
  const meta = role && role.meta ? role.meta : {}
  const allowInput = parseListField(meta.tools)
  const denyInput = parseListField(meta.disallowedTools ?? meta.disallowed_tools)
  const servers = parseListField(meta.mcp_servers ?? meta.mcpServers)
  const skills = parseListField(meta.skills)
  const warnings = []
  const allow = []
  const deny = []

  // Enumerate registered MCP tools for server expansion (parent view too, so a
  // preset-mounted MCP server is seen; fall back to the global view).
  let mcpTools = []
  try {
    const schemas = ctx.tools.schemas(parent) || ctx.tools.schemas() || []
    mcpTools = schemas.map((s) => s && s.name).filter((n) => typeof n === 'string' && n.startsWith('mcp__'))
  } catch {
    try {
      const schemas = ctx.tools.schemas() || []
      mcpTools = schemas.map((s) => s && s.name).filter((n) => typeof n === 'string' && n.startsWith('mcp__'))
    } catch {}
  }

  // Parent-visible tool set used for existence checks (shared across mapToolName
  // calls so we query schemas once per delegation).
  let parentVisible = null
  try {
    const set = new Set()
    for (const s of ctx.tools.schemas(parent)) if (s && s.name) set.add(s.name)
    parentVisible = set
  } catch {
    try {
      const set = new Set()
      for (const s of ctx.tools.schemas()) if (s && s.name) set.add(s.name)
      parentVisible = set
    } catch {}
  }

  const serverTools = new Set()
  for (const sv of servers) {
    const prefix = 'mcp__' + sv.toLowerCase() + '__'
    let matched = 0
    for (const n of mcpTools) {
      if (n.startsWith(prefix)) {
        serverTools.add(n)
        matched++
      }
    }
    if (matched === 0) warnings.push('mcp server "' + sv + '" not found or has no registered tools')
  }

  for (const n of allowInput) {
    const v = mapToolName(n, ctx, parent, parentVisible)
    if (v.length === 0) warnings.push('tool "' + n + '" unknown/unavailable in DSH (ignored)')
    else allow.push(...v)
  }
  for (const n of denyInput) {
    const v = mapToolName(n, ctx, parent, parentVisible)
    if (v.length === 0) warnings.push('disallowed tool "' + n + '" unknown/unavailable in DSH (ignored)')
    else deny.push(...v)
  }

  // mcp_servers semantics: with a `tools:` allowlist, add the servers' tools to
  // allow; without one, inherit the base set but deny every MCP tool outside the
  // listed servers.
  if (servers.length > 0) {
    if (allowInput.length === 0) {
      for (const n of mcpTools) if (!serverTools.has(n)) deny.push(n)
    } else {
      for (const n of serverTools) allow.push(n)
    }
  }

  // skills: explicit empty list -> hard-deny the skill tool; a whitelist -> soft
  // prompt-level restriction PLUS a hard per-child guard (installed in
  // `agent/created`) that denies skill calls for names outside the whitelist.
  let skillsPrompt = ''
  if (meta.skills !== undefined && skills.length === 0) {
    deny.push('skill')
  } else if (skills.length > 0) {
    skillsPrompt = '\n[技能约束] 你被限制只能使用以下技能：' + skills.join(', ') + '。禁止通过 skill 工具加载其它任何技能。'
  }

  const toolFilter = (allow.length > 0 || deny.length > 0) ? {
    ...(allow.length > 0 ? { allow: [...new Set(allow)] } : {}),
    ...(deny.length > 0 ? { deny: [...new Set(deny)] } : {})
  } : undefined

  return { toolFilter, skillsPrompt, warnings, skills }
}

function apply(ctx, config) {
  const configAO = (config && config.defaultAgentOptions && typeof config.defaultAgentOptions.provider === 'string' && config.defaultAgentOptions.provider.length > 0 && typeof config.defaultAgentOptions.model === 'string' && config.defaultAgentOptions.model.length > 0)
    ? { provider: config.defaultAgentOptions.provider, model: config.defaultAgentOptions.model }
    : undefined

  function resolveAgentOptions(role, parent) {
    const pm = role && role.meta ? role.meta : {}
    if (typeof pm.provider === 'string' && pm.provider.length > 0 && typeof pm.model === 'string' && pm.model.length > 0) {
      return { provider: pm.provider, model: pm.model }
    }
    if (configAO) return configAO
    const pr = parentRoute(parent)
    if (pr) return pr
    const am = ctx.get('agentDefaultModel')
    if (am) {
      const sel = am.currentSelection()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    }
    return FALLBACK_AGENT_OPTIONS
  }

  const roleFileName = (roleName) => roleName + (roleName.toLowerCase().endsWith('.md') ? '' : '.md')

  // First match wins across the ordered roots (config > project > global).
  async function readRole(roleName, parent) {
    if (!ROLE_NAME.test(roleName)) throw new Error('invalid subagent_type "' + roleName + '": use lowercase letters, digits and hyphens')
    const fileName = roleFileName(roleName)
    for (const root of await roleRoots(config, parent)) {
      const path = join(root, fileName)
      const info = await stat(path).catch(() => undefined)
      if (info && info.isFile()) {
        return { ...parseRole(await readFile(path, 'utf8')), path }
      }
    }
    return undefined
  }

  // Announce a spawned child to the host-level role guard (dsh-role-guard), so
  // the role frontmatter `skills:` restriction is enforced at host scope for
  // this child — foreground AND background, every preset. No-op when the guard
  // is not mounted yet (e.g. before restart): team_delegate stays fully usable.
  // The resolved absolute role path is passed so the guard reads the exact file
  // that won (config/project/global resolution stays consistent across the pair).
  function announceRole(childId, roleName, rolePath) {
    if (childId === undefined || childId === null || !roleName) return
    try {
      const roleGuard = ctx.get('roleGuard')
      if (roleGuard && typeof roleGuard.register === 'function') {
        Promise.resolve(roleGuard.register(String(childId), String(roleName), rolePath)).catch(() => {})
      }
    } catch {}
  }

  function unannounceRole(childId) {
    if (childId === undefined || childId === null) return
    try {
      const roleGuard = ctx.get('roleGuard')
      if (roleGuard && typeof roleGuard.unregister === 'function') roleGuard.unregister(String(childId))
    } catch {}
  }

  function messageOf(error) {
    return String(error && error.message ? error.message : error)
  }

  // The child's own systemPrompt service, as bound to the child's scope.
  // `agent.ctx` is the per-agent scope, so a section registered through it is
  // owned by the child's fiber (disposed with the child) and visible to no one
  // else. Returns undefined when the runtime exposes no prompt registry.
  function childSystemPrompt(agent) {
    try {
      const direct = agent.ctx.systemPrompt
      if (direct && typeof direct.section === 'function') return direct
    } catch {}
    try {
      const viaGet = agent.ctx.get('systemPrompt')
      if (viaGet && typeof viaGet.section === 'function') return viaGet
    } catch {}
    return undefined
  }

  // childId -> { persona, toolFilter, skills, warnings, agent }
  // Filled before startActivation, consumed by the `agent/created` listener.
  const pendingChildren = new Map()

  // Apply the role composition on the child's own scope. This runs while the
  // child is being published and before its first step assembles the prompt,
  // which is what makes a per-role persona possible again in 0.2.1.
  ctx.on('agent/created', ({ agent }) => {
    if (!agent) return
    const id = String(agent.id)
    const pending = pendingChildren.get(id)
    if (pending === undefined) return
    pendingChildren.delete(id)
    pending.agent = agent

    if (typeof pending.persona === 'string' && pending.persona.length > 0) {
      const systemPrompt = childSystemPrompt(agent)
      if (systemPrompt === undefined) {
        pending.warnings.push('role persona was not installed: the child exposes no systemPrompt service')
      } else {
        try {
          // `interpolate: false`: a role body is free text for the model, not a
          // template. Without it a stray `{{...}}` would make the runtime reject
          // the child's whole prompt assembly as an unknown prompt variable.
          systemPrompt.section({ name: ROLE_SECTION, order: ROLE_SECTION_ORDER, text: pending.persona, interpolate: false })
        } catch (error) {
          pending.warnings.push('role persona was not installed: ' + messageOf(error))
        }
      }
    }

    let childTools
    try {
      childTools = agent.ctx.get('tools')
    } catch {}

    if (pending.toolFilter !== undefined) {
      if (childTools && typeof childTools.restrict === 'function') {
        try {
          childTools.restrict(pending.toolFilter)
        } catch (error) {
          // The allow/deny set was resolved against the parent's live tool view,
          // so this is a rare race (a tool registered between resolution and
          // spawn). The host-level guard still enforces the role at call time.
          pending.warnings.push('role tool restriction was not applied: ' + messageOf(error))
        }
      } else {
        pending.warnings.push('role tool restriction was not applied: the child exposes no tools registry')
      }
    }

    // Hard skill enforcement: deny `skill` calls outside the role whitelist on
    // the child's own registry, so out-of-scope skills fail closed even when the
    // prompt-level hint is ignored.
    if (Array.isArray(pending.skills) && pending.skills.length > 0 && childTools && typeof childTools.guard === 'function') {
      try {
        const allowed = new Set(pending.skills)
        const list = pending.skills.join(', ')
        childTools.guard((execution) => {
          if (execution && execution.name === 'skill' && execution.arguments && typeof execution.arguments.name === 'string' && !allowed.has(execution.arguments.name)) {
            return 'this role may only load skills: ' + list
          }
          return undefined
        })
      } catch {}
    }
  })

  ctx.effect(() => () => pendingChildren.clear())

  // Start one child under a reserved id so the role composition (and the
  // host-level guard entry) exist before the child can run anything.
  async function startChild(request, options, plan) {
    if (typeof ctx.subagents.startActivation !== 'function') {
      throw new Error('team_delegate requires DSH >= 0.2.1: ctx.subagents.startActivation is unavailable in this runtime')
    }
    const childId = randomUUID()
    const pending = {
      persona: plan.persona,
      toolFilter: plan.toolFilter,
      skills: plan.skills,
      // Role-resolution warnings (unknown tool names, missing MCP servers) are
      // reported together with anything the child-scope install reports.
      warnings: Array.isArray(plan.warnings) ? [...plan.warnings] : [],
      agent: undefined
    }
    pendingChildren.set(childId, pending)
    announceRole(childId, options.roleName, options.rolePath)
    try {
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: options.label || options.roleName || 'subagent',
        childId,
        request,
        signal: options.signal,
        delivery: plan.delivery
      })
      // `agent/created` fires before startActivation resolves, so an entry still
      // queued here means the child never announced itself.
      if (pendingChildren.delete(childId)) pending.warnings.push('role composition was not applied: the child did not announce its creation')
      return { activation, pending, childId: String(activation.childId ?? childId) }
    } catch (error) {
      pendingChildren.delete(childId)
      unannounceRole(childId)
      throw error
    }
  }

  async function runForeground(request, options, plan) {
    const { activation, pending } = await startChild(request, options, { ...plan, delivery: 'caller' })
    let result
    let dump = ''
    try {
      result = await activation.result
      dump = dumpChildEvents(pending.agent, 4000)
    } catch (error) {
      // A rejected result promise is an infrastructure-level failure (not a model
      // stop reason). Normalize it so the caller's structured error path (and the
      // auth-retry) still runs instead of throwing past it.
      result = {
        stopReason: 'error',
        output: [{ type: 'text', text: 'subagent run rejected: ' + messageOf(error) }]
      }
    } finally {
      // Settled activations are already disposed by the runtime; calling dispose
      // again is the documented idempotent stop for this exact activation.
      try {
        await activation.dispose()
      } catch {}
      unannounceRole(activation.childId ?? pending.agent?.id)
    }
    return { result, dump, warnings: pending.warnings }
  }

  async function runBackground(request, options, plan) {
    const { pending, childId } = await startChild(request, options, { ...plan, delivery: 'parent' })
    return { childId, warnings: pending.warnings }
  }

  const delegateTool = defineTool({
    name: 'team_delegate',
    description: '委托给一个类型化团队成员子代理。每个角色在 <项目根>/.dsh/agents/ 或 $DSH_HOME/agents/<subagent_type>.md 中预定义（项目级优先于全局，从主代理工作目录向上定位项目根）；插件把该文件正文作为子代理的系统提示词（persona）注入，prompt 参数只放任务本身。角色 frontmatter 支持字段级控制：provider/model（模型路由）、tools（工具白名单，硬限制）、disallowedTools（工具黑名单，硬限制）、mcp_servers（MCP 服务器限定）、skills（技能限定）。未声明路由时自动回退到主代理当前实际使用的提供商/模型。先用 team_roles 查看可用角色，或用 team_find 按任务匹配角色。后台默认开启：返回 durable subagentId，可用 send_message 继续；设 run_in_background: false 则阻塞等待结果。',
    parameters: {
      subagent_type: { type: 'string', required: true, description: '角色键：<项目根>/.dsh/agents 或 $DSH_HOME/agents 下的 md 文件名（不带扩展名），如 data-cleaner-analyst' },
      description: { type: 'string', required: true, description: '简短任务描述（3-5 词，展示用）' },
      prompt: { type: 'string', required: true, description: '交给该角色的任务指令。角色设定与控制已作为系统提示词注入，这里写任务本身与产出要求' },
      run_in_background: { type: 'boolean', description: '默认 true：后台运行返回 subagentId；false：阻塞等待结果' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          subagentId: { type: 'string' },
          route: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true }
            }
          },
          message: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } }
        }
      },
      render(args, value) {
        let text
        if (value.kind === 'continuable') text = 'started team subagent ' + args.subagent_type + ' (subagentId: ' + value.subagentId + ')'
        else if (value.kind === 'foreground') text = value.message || 'subagent finished'
        else if (value.kind === 'not-found') text = 'no role file for subagent_type "' + args.subagent_type + '": ' + value.message
        else text = value.message || 'team_delegate failed'
        if (value.warnings && value.warnings.length > 0) text += '\n⚠️ ' + value.warnings.join('; ')
        return [{ type: 'text', text }]
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('team_delegate requires a calling agent (exec.agent was undefined)')
      const role = await readRole(args.subagent_type, parent)
      if (!role) {
        return { kind: 'not-found', message: 'no role file for "' + args.subagent_type + '" in ' + (await roleRoots(config, parent)).join(' or ') + ' — run team_roles to list available roles' }
      }
      const task = String(args.prompt || '')
      const body = role.body
      const hasTemplate = body.includes('{{') || body.includes('}}')
      const agentOptions = resolveAgentOptions(role, parent)
      const controls = buildRoleControls(role, ctx, parent)
      const label = args.description || args.subagent_type
      // 0.2.1 has no request.persona / request.toolFilter: the role body becomes a
      // child-scoped system-prompt section and the tool fields become a child-scoped
      // registry restriction, both installed in `agent/created` (see startChild).
      const plan = {
        // A templated body is a prompt (it contains its own placeholders), so it is
        // concatenated with the task instead of being installed as a persona.
        persona: body && !hasTemplate ? body + controls.skillsPrompt : undefined,
        toolFilter: controls.toolFilter,
        skills: controls.skills,
        warnings: controls.warnings
      }
      const request = {
        prompt: [{ type: 'text', text: hasTemplate ? body + '\n\n--- 任务 ---\n\n' + task + controls.skillsPrompt : task + controls.skillsPrompt }],
        parent,
        agentOptions
      }
      const options = { roleName: args.subagent_type, rolePath: role.path, signal: exec.signal, label }

      if (args.run_in_background === false) {
        let run = await runForeground(request, options, plan)
        let routeUsed = agentOptions
        const pr = parentRoute(parent)
        if (looksLikeAuth(run.result, run.dump) && pr && !sameRoute(pr, agentOptions)) {
          const retry = Object.assign({}, request, { agentOptions: pr })
          run = await runForeground(retry, options, plan)
          routeUsed = pr
        }
        const error = stopReasonError(run.result)
        if (error) {
          const partial = blockText(run.result.output)
          return { kind: 'error', message: error + '\nroute: ' + routeUsed.provider + '/' + routeUsed.model + '\n--- child events ---\n' + (run.dump || partial), warnings: run.warnings }
        }
        return { kind: 'foreground', route: { provider: routeUsed.provider, model: routeUsed.model }, message: blockText(run.result.output), warnings: run.warnings }
      }

      const background = await runBackground(request, options, plan)
      return { kind: 'continuable', subagentId: background.childId, warnings: background.warnings }
    }
  })

  const rolesTool = defineTool({
    name: 'team_roles',
    description: '列出所有可用的团队成员角色（subagent_type、provider/model、描述与字段级控制）：从 <项目根>/.dsh/agents 与 $DSH_HOME/agents 汇总（项目级优先），同名字只出现一次。调用 team_delegate 前先运行它以确认可用的角色名。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          roles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subagent_type: { type: 'string', required: true },
                name: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                tools: { type: 'string' },
                disallowedTools: { type: 'string' },
                skills: { type: 'string' },
                mcp_servers: { type: 'string' },
                description: { type: 'string' }
              }
            }
          }
        }
      },
      render(args, value) {
        const lines = value.roles.map((r) => {
          const route = (r.provider || r.model) ? ' [' + (r.provider || '?') + '/' + (r.model || '?') + ']' : ''
          const controls = []
          if (r.tools) controls.push('tools:' + r.tools)
          if (r.disallowedTools) controls.push('no:' + r.disallowedTools)
          if (r.skills) controls.push('skills:' + r.skills)
          if (r.mcp_servers) controls.push('mcp:' + r.mcp_servers)
          return '- ' + r.subagent_type + route + (r.name ? ' (' + r.name + ')' : '') + (controls.length ? ' ⚙{' + controls.join(' | ') + '}' : '') + (r.description ? ': ' + r.description : '')
        })
        return [{ type: 'text', text: lines.length ? 'Available team roles:\n' + lines.join('\n') : 'No role files found under <projectRoot>/.dsh/agents or $DSH_HOME/agents — create <subagent_type>.md files there.' }]
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roots = await roleRoots(config, exec && exec.agent)
      const roles = []
      const seen = new Set()
      for (const root of roots) {
        let entries
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          const subagent_type = entry.name.slice(0, -3)
          if (!ROLE_NAME.test(subagent_type)) continue
          if (seen.has(subagent_type)) continue
          seen.add(subagent_type)
          let parsed = { body: '', meta: {} }
          try {
            parsed = parseRole(await readFile(join(root, entry.name), 'utf8'))
          } catch {}
          roles.push({
            subagent_type,
            name: parsed.meta.name || '',
            provider: parsed.meta.provider || '',
            model: parsed.meta.model || '',
            tools: stringifyList(parsed.meta.tools),
            disallowedTools: stringifyList(parsed.meta.disallowedTools ?? parsed.meta.disallowed_tools),
            skills: stringifyList(parsed.meta.skills),
            mcp_servers: stringifyList(parsed.meta.mcp_servers ?? parsed.meta.mcpServers),
            description: parsed.meta.description || ''
          })
        }
      }
      roles.sort((a, b) => a.subagent_type.localeCompare(b.subagent_type))
      return { roles }
    }
  })

  const findTool = defineTool({
    name: 'team_find',
    description: '根据任务描述自动匹配最合适的团队成员角色：对每个角色 frontmatter 的 description（含 name/subagent_type）做分词打分，返回按匹配度排序的候选，供 team_delegate 选用。角色描述建议采用 Claude Code 风格的触发式写法（如 "Use this agent when you need to X, Y, or Z"）以获得更好的匹配效果。',
    parameters: {
      task: { type: 'string', required: true, description: '任务描述（自然语言）：想做什么、需要什么角色' },
      limit: { type: 'number', description: '返回候选数，默认 3' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subagent_type: { type: 'string', required: true },
                name: { type: 'string' },
                score: { type: 'number', required: true },
                description: { type: 'string' }
              }
            }
          }
        }
      },
      render(args, value) {
        const lines = value.matches.map((m) => {
          const pct = Math.round(m.score * 100)
          return '- ' + m.subagent_type + ' (score ' + pct + '%)' + (m.name ? ' [' + m.name + ']' : '') + (m.description ? ': ' + m.description : '')
        })
        return [{ type: 'text', text: lines.length ? 'Best matching team roles:\n' + lines.join('\n') : 'No role matches found for the task.' }]
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = (args.limit && Number.isFinite(args.limit) && args.limit > 0) ? Math.min(Math.floor(args.limit), 10) : 3
      const taskCounts = tokenize(args.task || '')
      const roots = await roleRoots(config, exec && exec.agent)
      const matches = []
      const seen = new Set()
      for (const root of roots) {
        let entries
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          const subagent_type = entry.name.slice(0, -3)
          if (!ROLE_NAME.test(subagent_type)) continue
          if (seen.has(subagent_type)) continue
          seen.add(subagent_type)
          let parsed = { body: '', meta: {} }
          try {
            parsed = parseRole(await readFile(join(root, entry.name), 'utf8'))
          } catch {
            continue
          }
          const desc = parsed.meta.description || ''
          const name = parsed.meta.name || ''
          const hay = [desc, name, subagent_type].filter(Boolean).join(' ')
          const score = scoreTask(taskCounts, tokenize(hay))
          matches.push({ subagent_type, name, score, description: desc })
        }
      }
      matches.sort((a, b) => b.score - a.score)
      return { matches: matches.slice(0, limit) }
    }
  })

  const d1 = ctx.tools.register(delegateTool)
  const d2 = ctx.tools.register(rolesTool)
  const d3 = ctx.tools.register(findTool)
  ctx.effect(() => () => { d1(); d2(); d3() })
}

export { Config, apply, inject, name }
