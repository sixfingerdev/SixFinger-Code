import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Team } from "../team/team"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service | Team.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const team = yield* Team.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Teammates have no user-facing surface: surface their questions on
          // the lead session so the lead answers and the teammate unblocks.
          const membership = yield* team.teamOf(ctx.sessionID)
          const sessionID = membership && !membership.isLead ? membership.team.leadSessionID : ctx.sessionID
          const answers = yield* question.ask({
            sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
