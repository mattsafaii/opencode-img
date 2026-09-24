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

describe("gpt_imagegen provider selection", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  function buildTool(fetchImpl: typeof globalThis.fetch) {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: fetchImpl,
    })
  }

  it("uses the openai provider by default", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = buildTool(recorder.fetch)

    const result = await tool.execute(
      { prompt: "a pixel", outputPath: "default.png" },
      fakeContext(),
    )

    assert.equal(result.metadata?.provider, "openai")
    assert.match(recorder.calls[0]!.url, /\/images\/generations$/)
  })

  it("accepts an explicit provider, case-insensitively", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = buildTool(recorder.fetch)

    const result = await tool.execute(
      { prompt: "a pixel", outputPath: "explicit.png", provider: "OPENAI" },
      fakeContext(),
    )

    assert.equal(result.metadata?.provider, "openai")
  })

  it("rejects an unknown provider before any request, naming it", async () => {
    const recorder = forbiddenFetch()
    const tool = buildTool(recorder.fetch)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "a pixel", outputPath: "unknown.png", provider: "midjourney" },
          fakeContext(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "invalid_argument")
        assert.match(error.message, /midjourney/)
        assert.match(error.message, /openai/)
        return true
      },
    )
    assert.equal(recorder.calls.length, 0)
  })
})
