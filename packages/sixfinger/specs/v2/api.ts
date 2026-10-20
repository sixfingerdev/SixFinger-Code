// @ts-nocheck

import { SixFinger } from "@sixfinger/core"
import { ReadTool } from "@sixfinger/core/tools"

const sixfinger = SixFinger.make({})

sixfinger.tool.add(ReadTool)

sixfinger.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

sixfinger.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

sixfinger.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await sixfinger.session.create({
  agent: "build",
})

sixfinger.subscribe((event) => {
  console.log(event)
})

await sixfinger.session.prompt({
  sessionID,
  text: "hey what is up",
})

await sixfinger.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await sixfinger.session.wait()

console.log(await sixfinger.session.messages(sessionID))
