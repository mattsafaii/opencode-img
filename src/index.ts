import { Plugin } from "@opencode/plugin"
import { createGptImagegenTool } from "./tool.ts"

/**
 * opencode-img — an OpenCode V2 plugin that adds the `gpt_imagegen` tool.
 *
 * Relative output and reference-image paths resolve against the session
 * directory. Each provider's API key comes from its environment variable, then
 * the OpenCode integration connection the user made with `/connect`.
 */
export default Plugin.define({
  id: "opencode-img",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add(
        createGptImagegenTool({
          resolveSessionDirectory: async (sessionID) => {
            const session = await ctx.session.get({ sessionID })
            return session.location.directory
          },
          resolveConnectionKey: async (integrationID) => {
            const connection = await ctx.integration.connection.active(integrationID)
            if (!connection) return undefined
            const credential = await ctx.integration.connection.resolve(connection)
            if (credential?.type === "key" && typeof credential.key === "string") {
              return credential.key
            }
            return undefined
          },
        }),
      )
    })
  },
})
