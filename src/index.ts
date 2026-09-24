import { Plugin } from "@opencode/plugin"
import { createGptImagegenTool } from "./tool.ts"

/**
 * Read the plugin options into the tool's defaults.
 *
 * A malformed option is ignored rather than failing the load; the provider id
 * and the model are validated when the tool runs, where the error can name the
 * call.
 */
function readDefaults(options: Readonly<Record<string, unknown>>): {
  defaultProvider?: string
  defaultModels?: Record<string, string>
} {
  const provider = options.provider
  const defaultProvider =
    typeof provider === "string" && provider.trim() !== "" ? provider : undefined

  const models = options.models
  const defaultModels =
    typeof models === "object" && models !== null
      ? Object.fromEntries(
          Object.entries(models).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[1] !== "",
          ),
        )
      : undefined

  return { defaultProvider, defaultModels }
}

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
    const { defaultProvider, defaultModels } = readDefaults(ctx.options)

    await ctx.tool.transform((editor) => {
      editor.add(
        createGptImagegenTool({
          defaultProvider,
          defaultModels,
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
