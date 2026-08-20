// dsh-role-guard: host-level TOOL / MCP / SKILL permission guard for
// role-directed team delegation. A USER-LEVEL HOST plugin mounted from the
// profile's `cordis.patch.yml`. It:
//
//   1. publishes a `roleGuard` host service so team_delegate can announce each
//      spawned child (`childId -> roleName`, plus the resolved role file path)
//      — the only coupling is that small announce; this plugin owns the
//      permission table and the enforcement. When team-delegate passes the
//      absolute role path, the guard reads that exact file (project-local
//      <root>/.dsh/agents roles work); without it, it falls back to its own
//      rolesDir resolution.
//   2. enforces the role frontmatter fields at HOST level through the
//      `tools/pre-execute` waterfall. Because it listens on the host root
//      scope, it covers every session, every preset, foreground AND background
//      children (a runtime backstop that catches tools registered after spawn,
//      plus the place where skills are hard-gated for every child):
//
//      tools: [a, b]        -> child may ONLY call a, b (exhaustive whitelist;
//                               `Skill` must be listed here for the skill tool)
//      disallowedTools: [x] -> child may never call x (blacklist)
//      mcp_servers: [S]     -> child may only call mcp__S__* MCP tools; with a
//                               `tools:` whitelist the server tools are added
//      skills:              -> (empty) every `skill` call is denied
//      skills: [a]          -> only `skill` calls for a are allowed
//      (no field)           -> that dimension is unrestricted
//
// The minimal frontmatter parser and the Claude-Code->DSH tool-name mapping
// mirror team-delegate/lib/index.js, so the two layers never disagree. The
// spawn-time toolFilter (team_delegate) handles prompt visibility; this guard
// is the authoritative runtime deny layer.
//
// Limitation (by design): a role child may still SEE other tools/skills in its
// catalog (no per-agent catalog filter), but calling a non-whitelisted one is
// hard-denied with a clear message.

import z from '@deepseek-ai/schemastery'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const name = 'dsh-role-guard'
const inject = []

const Config = z.object({
  rolesDir: z.string().default('')
})

const ROLE_NAME = /^[a-z0-9-]+$/

// Claude Code tool name -> DSH candidate names (mirrors team-delegate). Names
// with an empty list have no DSH equivalent and contribute nothing; anything
// not in the map passes through as-is (a DSH tool name or an mcp__* name).
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

function normalizeToolName(raw) {
  const key = String(raw).toLowerCase().replace(/[\s_-]/g, '')
  const mapped = TOOL_NAME_MAP[key]
  if (mapped !== undefined) return mapped
  return [String(raw)]
}

function resolveRolesDir(config) {
  if (config && typeof config.rolesDir === 'string' && config.rolesDir.length > 0) {
    return resolve(config.rolesDir)
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'agents')
}

// Same minimal frontmatter dialect as team-delegate/lib/index.js (mirrored
// verbatim so the two layers never disagree): supports plain `key: value`,
// YAML block lists (`key:` + indented `- item`), and inline comments.

// Strip an unquoted, outside-bracket YAML inline comment (` # ...`).
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

// Parse frontmatter lines into meta: list fields become string[] (block lists
// and inline `[a, b]` both), scalar fields stay strings.
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
  let closing = -1
  let i = firstNL + 1
  for (;;) {
    const nl = text.indexOf('\n', i)
    if (nl < 0) break
    if (text.slice(i, nl).replace(/\r$/, '') === '---') { closing = nl; break }
    i = nl + 1
  }
  if (closing < 0) return { body: text.trim(), meta: {} }
  const frontmatter = text.slice(firstNL + 1, closing)
  const body = text.slice(closing + 3).replace(/^\r?\n/, '').trim()
  return { body, meta: parseFrontmatterMeta(frontmatter) }
}

function parseListField(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  return String(value).replace(/[[\]{}]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
}

function apply(ctx, config) {
  const rolesDir = resolveRolesDir(config)
  // childId (string) -> { role, restricted, allowTools, denyTools, mcpServers, skillsDeclared, skills }
  const registered = new Map()

  // The absolute role file that won resolution, or undefined when team-delegate
  // did not announce one (then rolesDir + <role>.md is used as the fallback).
  async function readRoleRaw(roleName, rolePath) {
    if (rolePath && typeof rolePath === 'string' && rolePath.length > 0) {
      const info = await stat(rolePath).catch(() => undefined)
      if (info && info.isFile()) return await readFile(rolePath, 'utf8')
      return undefined
    }
    return await readFile(join(rolesDir, roleName + '.md'), 'utf8').catch(() => undefined)
  }

  // Read the role's frontmatter fresh on every announce, so edits are picked up
  // on the next delegation (no startup parse to go stale). Fast (<1ms) and only
  // runs once per delegation.
  async function announce(childId, roleName, rolePath) {
    const key = String(childId)
    const role = String(roleName)
    const info = {
      role,
      restricted: false,
      allowTools: null,
      denyTools: new Set(),
      mcpServers: null,
      skillsDeclared: false,
      skills: []
    }
    if (ROLE_NAME.test(role)) {
      try {
        const raw = await readRoleRaw(role, rolePath)
        if (raw !== undefined) {
          const meta = parseRole(raw).meta
          const allowRaw = parseListField(meta.tools)
          const denyRaw = parseListField(meta.disallowedTools ?? meta.disallowed_tools)
          const servers = parseListField(meta.mcp_servers ?? meta.mcpServers)
          if (allowRaw.length > 0) info.allowTools = new Set(allowRaw.flatMap(normalizeToolName))
          for (const n of denyRaw.flatMap(normalizeToolName)) info.denyTools.add(n)
          if (servers.length > 0) info.mcpServers = servers.map((s) => String(s).toLowerCase())
          if (meta.skills !== undefined) {
            info.skillsDeclared = true
            info.skills = parseListField(meta.skills)
          }
          info.restricted = info.allowTools !== null || info.denyTools.size > 0 || info.mcpServers !== null || info.skillsDeclared
        }
      } catch {
        // missing/unreadable role file: record the role with no restriction
      }
    }
    registered.set(key, info)
    return {
      ok: true,
      role,
      restricted: info.restricted,
      allowTools: info.allowTools ? Array.from(info.allowTools) : null,
      denyTools: Array.from(info.denyTools),
      mcpServers: info.mcpServers,
      skillsDeclared: info.skillsDeclared,
      skills: info.skills.slice()
    }
  }

  ctx.provide('roleGuard', {
    register(childId, roleName, rolePath) { return announce(childId, roleName, rolePath) },
    unregister(childId) { registered.delete(String(childId)) },
    list() {
      const out = []
      for (const [id, info] of registered) {
        out.push({
          childId: id,
          role: info.role,
          restricted: info.restricted,
          allowTools: info.allowTools ? Array.from(info.allowTools) : null,
          denyTools: Array.from(info.denyTools),
          mcpServers: info.mcpServers,
          skillsDeclared: info.skillsDeclared,
          skills: info.skills.slice()
        })
      }
      return out
    }
  })

  // The gate. Only calls from a REGISTERED role child with restrictions are
  // checked; the main agent and builtin subagents (no role) pass through.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!exec) return next()
    const agent = exec.agent
    if (!agent) return next()
    const info = registered.get(String(agent.id))
    if (!info || !info.restricted) return next()
    const name = exec.name

    // Mechanism-tool exemption: tools the child answers through live in the
    // child's OWN layer (not inherited), so DSH's restrict() never constrains
    // them ("must not strip the machinery it answers through"). Mirror that
    // here so a whitelist/blacklist cannot break the report channel a
    // continuable subagent is told to use before finishing.
    if (name === 'report') return next()

    // 1. disallowedTools — absolute blacklist.
    if (info.denyTools.has(name)) {
      return { kind: 'deny', reason: 'this role is not allowed to use: ' + name }
    }

    // 2. tools allowlist (exhaustive) + mcp_servers prefix control.
    const isMcp = name.startsWith('mcp__')
    let toolAllowed
    if (info.allowTools === null && info.mcpServers === null) {
      toolAllowed = true
    } else if (isMcp && info.mcpServers !== null) {
      toolAllowed = info.mcpServers.some((s) => name.startsWith('mcp__' + s + '__'))
      if (!toolAllowed && info.allowTools !== null && info.allowTools.has(name)) toolAllowed = true
    } else if (isMcp) {
      toolAllowed = info.allowTools !== null && info.allowTools.has(name)
    } else {
      toolAllowed = info.allowTools === null || info.allowTools.has(name)
    }
    if (!toolAllowed) {
      if (isMcp && info.mcpServers !== null) {
        return { kind: 'deny', reason: 'this role may only use MCP tools from servers: ' + info.mcpServers.join(', ') }
      }
      if (info.allowTools !== null) {
        return { kind: 'deny', reason: 'this role may only use tools: ' + Array.from(info.allowTools).join(', ') }
      }
      return { kind: 'deny', reason: 'this role is not allowed to use: ' + name }
    }

    // 3. skill whitelist (skill must also have passed the tools whitelist, so
    //    a role that wants both lists `Skill` in tools as well).
    if (name === 'skill' && info.skillsDeclared) {
      const called = exec.arguments && typeof exec.arguments.name === 'string' ? exec.arguments.name : ''
      if (info.skills.length === 0) {
        return { kind: 'deny', reason: 'this role does not allow loading skills' }
      }
      if (!info.skills.includes(called)) {
        return { kind: 'deny', reason: 'this role may only load skills: ' + info.skills.join(', ') }
      }
    }

    return next()
  })
}

export { Config, apply, inject, name }
