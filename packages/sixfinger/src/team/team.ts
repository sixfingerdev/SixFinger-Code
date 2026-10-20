import { Effect, Layer, Context, SynchronizedRef, Clock, Schema } from "effect"
import { makeGlobalNode } from "@sixfinger/core/effect/app-node"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Identifier } from "@sixfinger/core/id/id"
import { Global } from "@sixfinger/core/global"
import { SessionID } from "../session/schema"
import path from "path"

export const MAX_MEMBERS = 8
export const LEAD_NAME = "team-lead"

const COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan", "orange", "teal"] as const

export class TeamError extends Schema.TaggedErrorClass<TeamError>()("TeamError", {
  message: Schema.String,
}) {}

export type Member = {
  name: string
  agentId: string
  sessionID: SessionID
  agentType: string
  color: string
  joinedAt: number
}

export type Info = {
  name: string
  description?: string
  leadSessionID: SessionID
  leadAgentId: string
  members: Member[]
  createdAt: number
}

export const root = () => path.join(Global.Path.state, "teams")
export const dir = (name: string) => path.join(root(), name)
export const configFile = (name: string) => path.join(dir(name), "config.json")
export const inboxDir = (name: string) => path.join(dir(name), "inbox")
export const tasksDir = (name: string) => path.join(dir(name), "tasks")

export type MessageKind = "message" | "query" | "shutdown_request"

export type InboxMessage = {
  id: string
  from: string
  to: string
  kind: MessageKind
  createdAt: number
  content: string
}

export type TeamTask = {
  id: string
  title: string
  status: "open" | "in_progress" | "done"
  owner?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  description: string
}

export function sanitize(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

export function validName(name: string) {
  return /^[a-z0-9][a-z0-9-_]{0,31}$/.test(name)
}

export function agentId(name: string, team: string) {
  return `${name}@${team}`
}

export interface Interface {
  readonly create: (input: {
    name: string
    description?: string
    agentType?: string
    leadSessionID: SessionID
  }) => Effect.Effect<Info, TeamError>
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly delete: (name: string) => Effect.Effect<void>
  readonly addMember: (input: {
    team: string
    name: string
    sessionID: SessionID
    agentType: string
  }) => Effect.Effect<Member, TeamError>
  readonly removeMember: (input: { team: string; name: string }) => Effect.Effect<Member | undefined>
  readonly teamOf: (sessionID: SessionID) => Effect.Effect<{ team: Info; member?: Member; isLead: boolean } | undefined>
  readonly send: (input: {
    team: string
    from: string
    to: string
    kind: MessageKind
    content: string
  }) => Effect.Effect<InboxMessage, TeamError>
  readonly inbox: (input: { team: string; name: string; since?: number }) => Effect.Effect<InboxMessage[], TeamError>
  readonly awaitReply: (input: {
    team: string
    from: string
    since: number
    timeoutMs: number
  }) => Effect.Effect<InboxMessage | undefined, TeamError>
  readonly createTask: (input: {
    team: string
    title: string
    description?: string
    owner?: string
    createdBy: string
  }) => Effect.Effect<TeamTask, TeamError>
  readonly updateTask: (input: {
    team: string
    id: string
    status?: TeamTask["status"]
    owner?: string
    note?: string
  }) => Effect.Effect<TeamTask, TeamError>
  readonly listTasks: (input: { team: string; status?: TeamTask["status"] }) => Effect.Effect<TeamTask[], TeamError>
}

export class Service extends Context.Service<Service, Interface>()("@sixfinger/Team") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const teams = yield* SynchronizedRef.make(new Map<string, Info>())

    // Process-local lifetime: anything left on disk is stale from a previous
    // run, since live membership only exists in this registry.
    yield* fs.remove(root()).pipe(Effect.catch(() => Effect.void))
    yield* fs.ensureDir(root()).pipe(Effect.orDie)

    const persist = Effect.fn("Team.persist")(function* (info: Info) {
      yield* fs.writeWithDirs(configFile(info.name), JSON.stringify(info, null, 2)).pipe(Effect.orDie)
    })

    const create = Effect.fn("Team.create")(function* (input: {
      name: string
      description?: string
      agentType?: string
      leadSessionID: SessionID
    }) {
      const name = sanitize(input.name)
      if (!name || !validName(name)) return yield* new TeamError({ message: `Invalid team name: "${input.name}"` })
      const createdAt = yield* Clock.currentTimeMillis
      const leadAgentId = agentId(LEAD_NAME, name)
      const info: Info = {
        name,
        ...(input.description ? { description: input.description } : {}),
        leadSessionID: input.leadSessionID,
        leadAgentId,
        members: [
          {
            name: LEAD_NAME,
            agentId: leadAgentId,
            sessionID: input.leadSessionID,
            agentType: input.agentType ?? LEAD_NAME,
            color: COLORS[0],
            joinedAt: createdAt,
          },
        ],
        createdAt,
      }
      const exists = yield* SynchronizedRef.getAndUpdate(teams, (all) =>
        all.has(name) ? all : new Map(all).set(name, info),
      )
      if (exists.has(name)) return yield* new TeamError({ message: `Team "${name}" already exists` })
      yield* persist(info)
      return info
    })

    const get: Interface["get"] = Effect.fn("Team.get")(function* (name: string) {
      return (yield* SynchronizedRef.get(teams)).get(name)
    })

    const list: Interface["list"] = Effect.fn("Team.list")(function* () {
      return [...(yield* SynchronizedRef.get(teams)).values()].toSorted((a, b) => a.createdAt - b.createdAt)
    })

    const del: Interface["delete"] = Effect.fn("Team.delete")(function* (name: string) {
      yield* SynchronizedRef.update(teams, (all) => {
        const next = new Map(all)
        next.delete(name)
        return next
      })
      yield* fs.remove(dir(name)).pipe(Effect.catch(() => Effect.void))
    })

    const addMember: Interface["addMember"] = Effect.fn("Team.addMember")(function* (input: {
      team: string
      name: string
      sessionID: SessionID
      agentType: string
    }) {
      const name = sanitize(input.name)
      if (!name || !validName(name) || name === LEAD_NAME)
        return yield* new TeamError({ message: `Invalid teammate name: "${input.name}"` })
      const joinedAt = yield* Clock.currentTimeMillis
      type Added = { error: string } | { info: Info; member: Member }
      const updated = yield* SynchronizedRef.modify(teams, (all): readonly [Added, Map<string, Info>] => {
        const info = all.get(input.team)
        if (!info) return [{ error: `Unknown team: "${input.team}"` }, all]
        if (info.members.some((item) => item.name === name))
          return [{ error: `Teammate "${name}" is already on team "${input.team}"` }, all]
        if (info.members.length >= MAX_MEMBERS)
          return [{ error: `Team "${input.team}" is full (max ${MAX_MEMBERS} members)` }, all]
        const member: Member = {
          name,
          agentId: agentId(name, input.team),
          sessionID: input.sessionID,
          agentType: input.agentType,
          color: COLORS[info.members.length % COLORS.length],
          joinedAt,
        }
        const next = { ...info, members: [...info.members, member] }
        return [{ info: next, member }, new Map(all).set(input.team, next)]
      })
      if ("error" in updated) return yield* new TeamError({ message: updated.error })
      yield* persist(updated.info)
      return updated.member
    })

    const removeMember: Interface["removeMember"] = Effect.fn("Team.removeMember")(function* (input: {
      team: string
      name: string
    }) {
      const updated = yield* SynchronizedRef.modify(teams, (all) => {
        const current = all.get(input.team)
        const removed = current?.members.find((item) => item.name === input.name)
        if (!current || !removed || removed.name === LEAD_NAME) return [undefined, all] as const
        const info = { ...current, members: current.members.filter((item) => item.name !== input.name) }
        return [{ removed, info } as const, new Map(all).set(input.team, info)] as const
      })
      if (!updated) return undefined
      yield* persist(updated.info)
      return updated.removed
    })

    const teamOf: Interface["teamOf"] = Effect.fn("Team.teamOf")(function* (sessionID: SessionID) {
      for (const team of (yield* SynchronizedRef.get(teams)).values()) {
        if (team.leadSessionID === sessionID) return { team, member: team.members[0], isLead: true }
        const member = team.members.find((item) => item.sessionID === sessionID)
        if (member) return { team, member, isLead: false }
      }
      return undefined
    })

    function frontmatter(fields: Record<string, string>, body: string) {
      const head = Object.entries(fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")
      return `---\n${head}\n---\n\n${body}`
    }

    function parseFile(content: string) {
      const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)
      const fields: Record<string, string> = {}
      if (match) {
        for (const line of match[1].split("\n")) {
          const separator = line.indexOf(": ")
          if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 2)
        }
        return { fields, body: match[2] }
      }
      return { fields, body: content }
    }

    const requireTeam: (name: string) => Effect.Effect<Info, TeamError> = Effect.fn("Team.requireTeam")(
      function* (name: string) {
        const info = (yield* SynchronizedRef.get(teams)).get(name)
        if (!info) return yield* new TeamError({ message: `Unknown team: "${name}"` })
        return info
      },
    )

    const send: Interface["send"] = Effect.fn("Team.send")(function* (input: {
      team: string
      from: string
      to: string
      kind: MessageKind
      content: string
    }) {
      yield* requireTeam(input.team)
      if (!input.content.trim()) return yield* new TeamError({ message: "Message content is empty." })
      const createdAt = yield* Clock.currentTimeMillis
      const id = Identifier.ascending("message")
      const message: InboxMessage = {
        id,
        from: input.from,
        to: input.to,
        kind: input.kind,
        createdAt,
        content: input.content,
      }
      yield* fs
        .writeWithDirs(
          path.join(inboxDir(input.team), `${id}.md`),
          frontmatter(
            { id, from: input.from, to: input.to, kind: input.kind, created_at: String(createdAt) },
            input.content,
          ),
        )
        .pipe(Effect.orDie)
      return message
    })

    const readMessage = Effect.fn("Team.readMessage")(function* (teamName: string, file: string) {
      const content = yield* fs.readFileStringSafe(path.join(inboxDir(teamName), file)).pipe(Effect.orDie)
      if (!content) return undefined
      const { fields, body } = parseFile(content)
      if (!fields.from || !fields.to) return undefined
      return {
        id: fields.id || file.replace(/\.md$/, ""),
        from: fields.from,
        to: fields.to,
        kind: (fields.kind === "query" || fields.kind === "shutdown_request" ? fields.kind : "message") as MessageKind,
        createdAt: Number(fields.created_at) || 0,
        content: body,
      } satisfies InboxMessage
    })

    const inbox: Interface["inbox"] = Effect.fn("Team.inbox")(function* (input: {
      team: string
      name: string
      since?: number
    }) {
      yield* requireTeam(input.team)
      const exists = yield* fs.existsSafe(inboxDir(input.team)).pipe(Effect.orDie)
      if (!exists) return []
      const entries = yield* fs.readDirectoryEntries(inboxDir(input.team)).pipe(Effect.orDie)
      const messages: InboxMessage[] = []
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
        const message = yield* readMessage(input.team, entry.name)
        if (!message) continue
        if (message.to !== input.name && message.to !== "all") continue
        if (input.since !== undefined && message.createdAt <= input.since) continue
        messages.push(message)
      }
      return messages.toSorted((a, b) => a.createdAt - b.createdAt)
    })

    const awaitReply: Interface["awaitReply"] = Effect.fn("Team.awaitReply")(function* (input: {
      team: string
      from: string
      since: number
      timeoutMs: number
    }) {
      // Delivered-to names are unknown here, so scan the whole inbox for a
      // message from the recipient newer than the query.
      const deadline = Date.now() + input.timeoutMs
      while (Date.now() < deadline) {
        const exists = yield* fs.existsSafe(inboxDir(input.team)).pipe(Effect.orDie)
        if (exists) {
          const entries = yield* fs.readDirectoryEntries(inboxDir(input.team)).pipe(Effect.orDie)
          const fresh: InboxMessage[] = []
          for (const entry of entries) {
            if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
            const message = yield* readMessage(input.team, entry.name)
            if (message && message.from === input.from && message.createdAt > input.since) fresh.push(message)
          }
          if (fresh.length > 0) return fresh.toSorted((a, b) => a.createdAt - b.createdAt)[0]
        }
        yield* Effect.sleep("2 seconds")
      }
      return undefined
    })

    const readTask = Effect.fn("Team.readTask")(function* (teamName: string, file: string) {
      const content = yield* fs.readFileStringSafe(path.join(tasksDir(teamName), file)).pipe(Effect.orDie)
      if (!content) return undefined
      const { fields, body } = parseFile(content)
      if (!fields.title) return undefined
      return {
        id: fields.id || file.replace(/\.md$/, ""),
        title: fields.title,
        status: fields.status === "in_progress" || fields.status === "done" ? fields.status : "open",
        ...(fields.owner ? { owner: fields.owner } : {}),
        createdBy: fields.created_by ?? "unknown",
        createdAt: Number(fields.created_at) || 0,
        updatedAt: Number(fields.updated_at) || 0,
        description: body,
      } satisfies TeamTask
    })

    const createTask: Interface["createTask"] = Effect.fn("Team.createTask")(function* (input: {
      team: string
      title: string
      description?: string
      owner?: string
      createdBy: string
    }) {
      const info = yield* requireTeam(input.team)
      if (!input.title.trim()) return yield* new TeamError({ message: "Task title is empty." })
      if (input.owner && !info.members.some((item) => item.name === input.owner))
        return yield* new TeamError({ message: `"${input.owner}" is not on team "${input.team}".` })
      const now = yield* Clock.currentTimeMillis
      const id = Identifier.ascending("teamtask")
      const task: TeamTask = {
        id,
        title: input.title.trim(),
        status: "open",
        ...(input.owner ? { owner: input.owner } : {}),
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        description: input.description ?? "",
      }
      yield* fs
        .writeWithDirs(
          path.join(tasksDir(input.team), `${id}.md`),
          frontmatter(
            {
              id,
              title: task.title,
              status: task.status,
              ...(task.owner ? { owner: task.owner } : {}),
              created_by: task.createdBy,
              created_at: String(now),
              updated_at: String(now),
            },
            task.description,
          ),
        )
        .pipe(Effect.orDie)
      return task
    })

    const updateTask: Interface["updateTask"] = Effect.fn("Team.updateTask")(function* (input: {
      team: string
      id: string
      status?: TeamTask["status"]
      owner?: string
      note?: string
    }) {
      const info = yield* requireTeam(input.team)
      const file = path.join(tasksDir(input.team), `${input.id}.md`)
      const task = yield* readTask(input.team, `${input.id}.md`)
      if (!task) return yield* new TeamError({ message: `Unknown task: "${input.id}" on team "${input.team}".` })
      if (input.owner && !info.members.some((item) => item.name === input.owner))
        return yield* new TeamError({ message: `"${input.owner}" is not on team "${input.team}".` })
      const updatedAt = yield* Clock.currentTimeMillis
      const description = input.note ? `${task.description}\n\n[${new Date(updatedAt).toISOString()}] ${input.note}` : task.description
      const updated: TeamTask = {
        ...task,
        ...(input.status ? { status: input.status } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        updatedAt,
        description,
      }
      yield* fs
        .writeWithDirs(
          file,
          frontmatter(
            {
              id: updated.id,
              title: updated.title,
              status: updated.status,
              ...(updated.owner ? { owner: updated.owner } : {}),
              created_by: updated.createdBy,
              created_at: String(updated.createdAt),
              updated_at: String(updatedAt),
            },
            description,
          ),
        )
        .pipe(Effect.orDie)
      return updated
    })

    const listTasks: Interface["listTasks"] = Effect.fn("Team.listTasks")(function* (input: {
      team: string
      status?: TeamTask["status"]
    }) {
      yield* requireTeam(input.team)
      const exists = yield* fs.existsSafe(tasksDir(input.team)).pipe(Effect.orDie)
      if (!exists) return []
      const entries = yield* fs.readDirectoryEntries(tasksDir(input.team)).pipe(Effect.orDie)
      const tasks: TeamTask[] = []
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
        const task = yield* readTask(input.team, entry.name)
        if (!task) continue
        if (input.status && task.status !== input.status) continue
        tasks.push(task)
      }
      return tasks.toSorted((a, b) => a.createdAt - b.createdAt)
    })

    return Service.of({
      create,
      get,
      list,
      delete: del,
      addMember,
      removeMember,
      teamOf,
      send,
      inbox,
      awaitReply,
      createTask,
      updateTask,
      listTasks,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node] })

export * as Team from "./team"
