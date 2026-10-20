import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Team } from "@/team/team"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "./task"

const MAX_QUERY_MS = 60 * 60 * 1000

export const CreateParameters = Schema.Struct({
  team_name: Schema.String.annotate({ description: "Name for the new team to create." }),
  description: Schema.optional(Schema.String).annotate({ description: "What the team is working on." }),
  agent_type: Schema.optional(Schema.String).annotate({
    description: "Type of the team lead (defaults to team-lead). Used for coordination prompts.",
  }),
})

export const DeleteParameters = Schema.Struct({
  team_name: Schema.optional(Schema.String).annotate({
    description: "Name of the team to delete. Defaults to your own team.",
  }),
})

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: [
        "Create a new team for coordinating multiple agents.",
        "One team per session: creating again fails while you lead a team.",
        "After creating a team, spawn teammates with the task tool (team_name + name), hand out work with task_update owner, and talk to teammates with send_message.",
        "When the work is done, shut teammates down with send_message shutdown_request, then team_delete.",
      ].join(" "),
      parameters: CreateParameters,
      execute: (params: Schema.Schema.Type<typeof CreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "team",
            patterns: [params.team_name],
            always: [params.team_name],
            metadata: { description: params.description },
          })
          const leading = yield* team.list()
          const current = leading.find((item) => item.leadSessionID === ctx.sessionID)
          if (current) {
            throw new Team.TeamError({ message: `Already leading team "${current.name}". Use team_delete first.` })
          }
          const info = yield* team.create({
            name: params.team_name,
            description: params.description,
            agentType: params.agent_type,
            leadSessionID: ctx.sessionID,
          })
          return {
            title: `Team ${info.name} created`,
            metadata: {
              output: `Team "${info.name}" created with you as team-lead.`,
              team: info.name,
            },
            output: [
              `Team "${info.name}" created. You are team-lead (${info.leadAgentId}).`,
              `Next: spawn teammates with the task tool (team_name: "${info.name}", name: "<teammate-name>"), create work with task_create, assign with task_update owner, message with send_message.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TeamDeleteTool = Tool.define(
  "team_delete",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const background = yield* BackgroundJob.Service
    return {
      description: [
        "Delete a team and stop all of its teammates.",
        "Only the team lead can delete the team. Defaults to your own team.",
      ].join(" "),
      parameters: DeleteParameters,
      execute: (params: Schema.Schema.Type<typeof DeleteParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const membership = yield* team.teamOf(ctx.sessionID)
          const name = params.team_name ?? membership?.team.name
          if (!name) throw new Team.TeamError({ message: "You are not on a team." })
          const info = yield* team.get(name)
          if (!info) throw new Team.TeamError({ message: `Unknown team: "${name}"` })
          if (info.leadSessionID !== ctx.sessionID)
            throw new Team.TeamError({ message: `Only the team lead can delete team "${name}".` })
          yield* ctx.ask({
            permission: "team",
            patterns: [name],
            always: [name],
            metadata: {},
          })
          yield* Effect.forEach(
            info.members.filter((member) => member.sessionID !== ctx.sessionID),
            (member) => background.cancel(member.sessionID),
            { concurrency: "unbounded", discard: true },
          )
          yield* team.delete(name)
          return {
            title: `Team ${name} deleted`,
            metadata: { output: `Team "${name}" deleted.`, team: name },
            output: `Team "${name}" deleted and ${info.members.length - 1} teammate(s) stopped.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const SendMessageParameters = Schema.Struct({
  recipient: Schema.String.annotate({
    description: 'Who receives the message: a teammate name, "lead" for the team lead, or "all" for everyone.',
  }),
  content: Schema.String.annotate({ description: "Message content." }),
  type: Schema.optional(Schema.Literals(["message", "query", "shutdown_request"])).annotate({
    description:
      "message (default): delivered to the inbox, read on the recipient's next turn. query: wakes the recipient and blocks until they reply or timeout_ms passes. shutdown_request: wakes the recipient so they wrap up and stop.",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: "How long a query waits for a reply (default 600000, maximum 3600000). Ignored for other types.",
  }),
})

export const SendMessageTool = Tool.define(
  "send_message",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: [
        "Send a message to a teammate, the team lead, or the whole team.",
        "Messages land in the team inbox; plain messages are read on the recipient's next turn, while query and shutdown_request wake them immediately.",
        "A query blocks until the recipient answers with send_message or the timeout passes — the reply is returned as this call's output.",
        "Requires being on a team (spawn via the task tool with team_name, or create one with team_create).",
      ].join(" "),
      parameters: SendMessageParameters,
      execute: (params: Schema.Schema.Type<typeof SendMessageParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const membership = yield* team.teamOf(ctx.sessionID)
          if (!membership || !membership.member) throw new Team.TeamError({ message: "You are not on a team." })
          const info = membership.team
          const me = membership.isLead ? Team.LEAD_NAME : membership.member.name
          const kind = params.type ?? "message"

          const recipientSession =
            params.recipient === "all"
              ? undefined
              : params.recipient === "lead" || params.recipient === info.leadAgentId
                ? info.leadSessionID
                : info.members.find((item) => item.name === params.recipient || item.agentId === params.recipient)
                    ?.sessionID
          if (params.recipient !== "all" && !recipientSession)
            throw new Team.TeamError({ message: `"${params.recipient}" is not on team "${info.name}".` })
          if (recipientSession === ctx.sessionID) throw new Team.TeamError({ message: "You cannot message yourself." })

          const message = yield* team.send({
            team: info.name,
            from: me,
            to:
              params.recipient === "lead" || params.recipient === info.leadAgentId ? Team.LEAD_NAME : params.recipient,
            kind,
            content: params.content,
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if ((kind === "query" || kind === "shutdown_request") && recipientSession) {
            if (!ops) throw new Team.TeamError({ message: `${kind} requires promptOps in tool context.` })
            const label = kind === "query" ? "question" : "shutdown request"
            yield* ops
              .prompt({
                sessionID: recipientSession,
                parts: [
                  {
                    type: "text",
                    synthetic: true,
                    text: [
                      `<inbox id="${message.id}" kind="${kind}" from="${me}" team="${info.name}">`,
                      `You have an urgent ${label} from ${me}. Read ${Team.inboxDir(info.name)}/${message.id}.md now and act on it.`,
                      kind === "query"
                        ? `Answer with send_message to ${me}; the sender is blocked waiting for your reply.`
                        : `Wrap up the smallest safe unit of work, report status with send_message to the lead, then end your turn.`,
                      `</inbox>`,
                    ].join("\n"),
                  },
                ],
              })
              .pipe(Effect.ignore)
          }

          if (kind !== "query" || !recipientSession) {
            const output =
              kind === "message"
                ? `Message delivered to ${params.recipient} (inbox ${message.id}). They read it on their next turn.`
                : `Shutdown request delivered to ${params.recipient} (inbox ${message.id}).`
            return { title: `Message to ${params.recipient}`, metadata: { output, team: info.name }, output }
          }

          const timeoutMs = Math.min(Math.max(params.timeout_ms ?? 600000, 1000), MAX_QUERY_MS)
          const reply = yield* team.awaitReply({
            team: info.name,
            from: params.recipient === "lead" ? Team.LEAD_NAME : params.recipient,
            since: message.createdAt,
            timeoutMs,
          })
          if (!reply) {
            const output = `Query to ${params.recipient} timed out after ${Math.round(timeoutMs / 1000)}s with no reply.`
            return { title: `Query to ${params.recipient} timed out`, metadata: { output, team: info.name }, output }
          }
          const output = [`<reply from="${reply.from}" id="${reply.id}">`, reply.content, `</reply>`].join("\n")
          return { title: `Reply from ${reply.from}`, metadata: { output, team: info.name }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TeamTaskCreateParameters = Schema.Struct({
  team_name: Schema.optional(Schema.String).annotate({ description: "Team name. Defaults to your own team." }),
  title: Schema.String.annotate({ description: "Short task title." }),
  description: Schema.optional(Schema.String).annotate({ description: "What needs to be done." }),
  owner: Schema.optional(Schema.String).annotate({ description: "Teammate name this task is assigned to." }),
})

export const TeamTaskCreateTool = Tool.define(
  "task_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: [
        "Create a work item in the team task list, optionally assigned to a teammate via owner.",
        "Teammates pick up tasks assigned to them and update status with task_update.",
      ].join(" "),
      parameters: TeamTaskCreateParameters,
      execute: (params: Schema.Schema.Type<typeof TeamTaskCreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const membership = yield* team.teamOf(ctx.sessionID)
          const name = params.team_name ?? membership?.team.name
          if (!name) throw new Team.TeamError({ message: "You are not on a team." })
          const me = !membership ? "unknown" : membership.isLead ? Team.LEAD_NAME : (membership.member?.name ?? "unknown")
          const task = yield* team.createTask({
            team: name,
            title: params.title,
            description: params.description,
            owner: params.owner,
            createdBy: me,
          })
          const output = `Task "${task.title}" created (${task.id})${task.owner ? `, assigned to ${task.owner}` : ""}. File: ${Team.tasksDir(name)}/${task.id}.md`
          return { title: `Task ${task.id} created`, metadata: { output, team: name }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TeamTaskUpdateParameters = Schema.Struct({
  team_name: Schema.optional(Schema.String).annotate({ description: "Team name. Defaults to your own team." }),
  id: Schema.String.annotate({ description: "Task ID returned by task_create." }),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done"])).annotate({
    description: "New task status.",
  }),
  owner: Schema.optional(Schema.String).annotate({ description: "Reassign the task to another teammate." }),
  note: Schema.optional(Schema.String).annotate({ description: "Progress note appended to the task file." }),
})

export const TeamTaskUpdateTool = Tool.define(
  "task_update",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: "Update a team task: status, owner assignment, or append a progress note.",
      parameters: TeamTaskUpdateParameters,
      execute: (params: Schema.Schema.Type<typeof TeamTaskUpdateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const membership = yield* team.teamOf(ctx.sessionID)
          const name = params.team_name ?? membership?.team.name
          if (!name) throw new Team.TeamError({ message: "You are not on a team." })
          const task = yield* team.updateTask({
            team: name,
            id: params.id,
            status: params.status,
            owner: params.owner,
            note: params.note,
          })
          const output = `Task "${task.title}" (${task.id}) updated: status=${task.status}${task.owner ? `, owner=${task.owner}` : ""}.`
          return { title: `Task ${task.id} updated`, metadata: { output, team: name }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TeamTaskListParameters = Schema.Struct({
  team_name: Schema.optional(Schema.String).annotate({ description: "Team name. Defaults to your own team." }),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "done"])).annotate({
    description: "Only list tasks with this status.",
  }),
})

export const TeamTaskListTool = Tool.define(
  "task_list",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: "List team tasks, optionally filtered by status.",
      parameters: TeamTaskListParameters,
      execute: (params: Schema.Schema.Type<typeof TeamTaskListParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const membership = yield* team.teamOf(ctx.sessionID)
          const name = params.team_name ?? membership?.team.name
          if (!name) throw new Team.TeamError({ message: "You are not on a team." })
          const tasks = yield* team.listTasks({ team: name, status: params.status })
          if (tasks.length === 0) {
            const output = "No tasks."
            return { title: "No tasks", metadata: { output, team: name }, output }
          }
          const output = tasks
            .map((task) => `- ${task.id} [${task.status}]${task.owner ? ` @${task.owner}` : ""}: ${task.title}`)
            .join("\n")
          return { title: `${tasks.length} task(s)`, metadata: { output, team: name }, output }
        }).pipe(Effect.orDie),
    }
  }),
)
