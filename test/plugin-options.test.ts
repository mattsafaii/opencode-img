import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { createGptImagegenTool, type GptImagegenDependencies } from "../src/tool.ts"
import {
  ONE_PIXEL_PNG_BASE64,
  fakeContext,
  forbiddenFetch,
  generationPayload,
  jsonResponse,
  makeTempDirectory,
  recordingFetch,
  removeTempDirectory,
} from "./helpers.ts"

function geminiPayload(): Record<string, unknown> {
  return {
    steps: [
      {
        type: "model_output",
        content: [{ type: "image", mime_type: "image/png", data: ONE_PIXEL_PNG_BASE64 }],
      },
    ],
  }
}

describe("gpt_imagegen plugin options", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  function buildTool(overrides: Omit<Partial<GptImagegenDependencies>, "resolveSessionDirectory">) {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      ...overrides,
    })
  }

  it("uses the default provider from the options", async () => {
    const recorder = recordingFetch(() => jsonResponse(geminiPayload()))
    const tool = buildTool({
      env: { GEMINI_API_KEY: "gm-test" },
      defaultProvider: "gemini",
      fetch: recorder.fetch,
    })

    const result = await tool.execute({ prompt: "a pixel", outputPath: "default.png" }, fakeContext())

    assert.equal(result.metadata?.provider, "gemini")
    assert.match(recorder.calls[0]!.url, /\/interactions$/)
  })

  it("uses the per-provider default model from the options", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = buildTool({
      env: { OPENAI_API_KEY: "sk-test" },
      defaultModels: { openai: "gpt-image-2" },
      fetch: recorder.fetch,
    })

    const result = await tool.execute({ prompt: "a pixel", outputPath: "model.png" }, fakeContext())

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.model, "gpt-image-2")
    assert.equal(result.metadata?.model, "gpt-image-2")
  })

  it("lets a per-call provider and model win over the options", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = buildTool({
      env: { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "gm-test" },
      defaultProvider: "gemini",
      defaultModels: { openai: "gpt-image-2" },
      fetch: recorder.fetch,
    })

    await tool.execute(
      { prompt: "a pixel", outputPath: "override.png", provider: "openai", model: "gpt-image-1" },
      fakeContext(),
    )

    assert.match(recorder.calls[0]!.url, /\/images\/generations$/)
    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.model, "gpt-image-1")
  })

  it("rejects an unknown default provider before any request", async () => {
    const recorder = forbiddenFetch()
    const tool = buildTool({
      env: { OPENAI_API_KEY: "sk-test" },
      defaultProvider: "midjourney",
      fetch: recorder.fetch,
    })

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "x.png" }, fakeContext()),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(recorder.calls.length, 0)
  })
})
