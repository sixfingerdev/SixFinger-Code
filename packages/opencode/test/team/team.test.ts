import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Team } from "@/team/team"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Team.node))

const lead = SessionID.make("ses_lead")

describe("team", () => {
  it.instance("creates a team with the caller as lead", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      const info = yield* team.create({ name: "My Team!", leadSessionID: lead })

      expect(info.name).toBe("my-team")
      expect(info.leadSessionID).toBe(lead)
      expect(info.members).toHaveLength(1)
      expect(info.members[0].name).toBe(Team.LEAD_NAME)
      expect(info.members[0].agentId).toBe("team-lead@my-team")
    }),
  )

  it.instance("rejects a second team for the same lead session", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "first", leadSessionID: lead })
      const duplicate = yield* team.create({ name: "first", leadSessionID: lead }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(Team.TeamError)
    }),
  )

  it.instance("adds and removes members with cap enforcement", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "squad", leadSessionID: lead })
      const member = yield* team.addMember({
        team: "squad",
        name: "Researcher",
        sessionID: SessionID.make("ses_member"),
        agentType: "explore",
      })

      expect(member.name).toBe("researcher")
      expect(member.agentId).toBe("researcher@squad")
      expect(member.color).not.toBe("")

      const duplicate = yield* team
        .addMember({ team: "squad", name: "researcher", sessionID: SessionID.make("ses_other"), agentType: "build" })
        .pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(Team.TeamError)

      const resolved = yield* team.teamOf(SessionID.make("ses_member"))
      expect(resolved?.team.name).toBe("squad")
      expect(resolved?.member?.name).toBe("researcher")
      expect(resolved?.isLead).toBe(false)

      const leadership = yield* team.teamOf(lead)
      expect(leadership?.isLead).toBe(true)

      const removed = yield* team.removeMember({ team: "squad", name: "researcher" })
      expect(removed?.name).toBe("researcher")
      expect(yield* team.teamOf(SessionID.make("ses_member"))).toBeUndefined()

      const leadRemoved = yield* team.removeMember({ team: "squad", name: Team.LEAD_NAME })
      expect(leadRemoved).toBeUndefined()
    }),
  )

  it.instance("deletes the team", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "temp", leadSessionID: lead })
      yield* team.delete("temp")
      expect(yield* team.get("temp")).toBeUndefined()
      expect(yield* team.list()).toHaveLength(0)
    }),
  )

  it.instance("delivers inbox messages and filters by recipient", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "msgs", leadSessionID: lead })
      yield* team.addMember({
        team: "msgs",
        name: "worker",
        sessionID: SessionID.make("ses_worker"),
        agentType: "build",
      })

      yield* team.send({ team: "msgs", from: Team.LEAD_NAME, to: "worker", kind: "message", content: "hello worker" })
      yield* team.send({ team: "msgs", from: Team.LEAD_NAME, to: "all", kind: "message", content: "hello all" })
      yield* team.send({ team: "msgs", from: "worker", to: Team.LEAD_NAME, kind: "message", content: "hi lead" })

      const workerInbox = yield* team.inbox({ team: "msgs", name: "worker" })
      expect(workerInbox.map((item) => item.content)).toEqual(["hello worker", "hello all"])

      const leadInbox = yield* team.inbox({ team: "msgs", name: Team.LEAD_NAME })
      expect(leadInbox.map((item) => item.content)).toEqual(["hello all", "hi lead"])

      const since = workerInbox[1].createdAt
      expect(yield* team.inbox({ team: "msgs", name: "worker", since })).toHaveLength(0)
    }),
  )

  it.instance("awaitReply resolves on reply and times out", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "query", leadSessionID: lead })
      const sent = yield* team.send({
        team: "query",
        from: Team.LEAD_NAME,
        to: "all",
        kind: "query",
        content: "are you there?",
      })
      yield* team.send({ team: "query", from: "ghost", to: Team.LEAD_NAME, kind: "message", content: "yes" })
      const reply = yield* team.awaitReply({ team: "query", from: "ghost", since: sent.createdAt, timeoutMs: 5000 })
      expect(reply?.content).toBe("yes")

      const missing = yield* team.awaitReply({ team: "query", from: "nobody", since: sent.createdAt, timeoutMs: 100 })
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("tracks file tasks with owner and status", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.create({ name: "work", leadSessionID: lead })
      yield* team.addMember({
        team: "work",
        name: "worker",
        sessionID: SessionID.make("ses_worker"),
        agentType: "build",
      })

      const task = yield* team.createTask({
        team: "work",
        title: "Write tests",
        description: "Cover the new tools.",
        owner: "worker",
        createdBy: Team.LEAD_NAME,
      })
      expect(task.status).toBe("open")
      expect(task.owner).toBe("worker")

      const badOwner = yield* team
        .createTask({ team: "work", title: "Bad", owner: "ghost", createdBy: Team.LEAD_NAME })
        .pipe(Effect.flip)
      expect(badOwner).toBeInstanceOf(Team.TeamError)

      const updated = yield* team.updateTask({ team: "work", id: task.id, status: "in_progress", note: "started" })
      expect(updated.status).toBe("in_progress")
      expect(updated.description).toContain("started")

      const open = yield* team.listTasks({ team: "work", status: "open" })
      expect(open).toHaveLength(0)
      const all = yield* team.listTasks({ team: "work" })
      expect(all).toHaveLength(1)

      const missing = yield* team.updateTask({ team: "work", id: "tsk_missing", status: "done" }).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(Team.TeamError)
    }),
  )
})
