import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { createGptImagegenTool } from "../src/tool.ts"
import {
  fakeContext,
  forbiddenFetch,
  generationPayload,
  jsonResponse,
  makeTempDirectory,
  recordingFetch,
  removeTempDirectory,
} from "./helpers.ts"

type Dependencies = Parameters<typeof createGptImagegenTool>[0]

describe("gpt_imagegen API key resolution", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  function buildTool(overrides: Partial<Dependencies>) {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      ...overrides,
    })
  }

  async function usedKey(overrides: Partial<Dependencies>): Promise<string | undefined> {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = buildTool({ ...overrides, fetch: recorder.fetch })
    await tool.execute({ prompt: "a pixel", outputPath: "pixel.png" }, fakeContext())
    const headers = recorder.calls[0]!.init.headers as Record<string, string>
    return headers.Authorization
  }

  it("uses the environment key when one is set", async () => {
    assert.equal(
      await usedKey({
        env: { OPENAI_API_KEY: "sk-env" },
        resolveApiKey: async () => "sk-connection",
      }),
      "Bearer sk-env",
    )
  })

  it("falls back to the OpenAI connection when the environment is absent", async () => {
    assert.equal(
      await usedKey({ env: {}, resolveApiKey: async () => "sk-connection" }),
      "Bearer sk-connection",
    )
  })

  it("fails before any request when no key is available, naming the ways to set one", async () => {
    const recorder = forbiddenFetch()
    const tool = buildTool({ env: {}, resolveApiKey: async () => undefined, fetch: recorder.fetch })

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "pixel.png" }, fakeContext()),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "missing_api_key")
        assert.match(error.message, /\/connect/)
        assert.match(error.message, /OPENAI_API_KEY/)
        return true
      },
    )
    assert.equal(recorder.calls.length, 0)
  })
})
