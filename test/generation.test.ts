import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { createGptImagegenTool } from "../src/tool.ts"
import {
  ONE_PIXEL_PNG,
  fakeContext,
  forbiddenFetch,
  generationPayload,
  jsonResponse,
  makeTempDirectory,
  recordingFetch,
  removeTempDirectory,
} from "./helpers.ts"

describe("gpt_imagegen generation", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  it("saves a generated image at the requested relative path and returns it", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch,
    })

    const result = await tool.execute(
      { prompt: "a single red pixel", outputPath: "out/pixel.png" },
      fakeContext(),
    )

    const expectedPath = join(sessionDirectory, "out", "pixel.png")
    assert.equal(result.metadata?.path, expectedPath)
    assert.deepEqual(await readFile(expectedPath), ONE_PIXEL_PNG)
    assert.match(String(result.content), /pixel\.png/)

    assert.equal(calls.length, 1)
    assert.match(calls[0]!.url, /\/images\/generations$/)
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.prompt, "a single red pixel")
    assert.equal(body.model, "gpt-image-1.5")
    assert.equal(body.n, 1)
  })

  it("resolves a nested relative path against the session directory", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch,
    })

    const result = await tool.execute(
      { prompt: "a pixel", outputPath: "nested/deeper/pixel.png" },
      fakeContext(),
    )

    const expectedPath = join(sessionDirectory, "nested", "deeper", "pixel.png")
    assert.equal(result.metadata?.path, expectedPath)
    assert.deepEqual(await readFile(expectedPath), ONE_PIXEL_PNG)
  })

  it("fails before any network request when OPENAI_API_KEY is missing", async () => {
    const { fetch, calls } = forbiddenFetch()
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: {},
      fetch,
    })

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "pixel.png" }, fakeContext()),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "missing_api_key")
        assert.match(error.message, /OPENAI_API_KEY/)
        return true
      },
    )
    assert.equal(calls.length, 0)
  })

  it("rejects an empty prompt before any network request", async () => {
    const { fetch, calls } = forbiddenFetch()
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch,
    })

    await assert.rejects(
      () => tool.execute({ prompt: "  ", outputPath: "pixel.png" }, fakeContext()),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(calls.length, 0)
  })
})
