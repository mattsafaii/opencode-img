import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { createGptImagegenTool } from "../src/tool.ts"
import {
  ONE_PIXEL_PNG,
  ONE_PIXEL_PNG_BASE64,
  fakeContext,
  forbiddenFetch,
  jsonResponse,
  makeTempDirectory,
  recordingFetch,
  removeTempDirectory,
} from "./helpers.ts"

function interactionPayload(base64: string = ONE_PIXEL_PNG_BASE64): Record<string, unknown> {
  return {
    id: "int_test",
    steps: [
      {
        type: "model_output",
        content: [{ type: "image", mime_type: "image/png", data: base64 }],
      },
    ],
  }
}

describe("gpt_imagegen gemini provider", () => {
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

  it("generates through the Gemini interactions endpoint", async () => {
    const recorder = recordingFetch(() => jsonResponse(interactionPayload()))
    const tool = buildTool(recorder.fetch)

    const result = await tool.execute(
      { prompt: "a banana", outputPath: "gemini/generate.png", provider: "gemini" },
      fakeContext(),
    )

    assert.equal(result.metadata?.provider, "gemini")
    assert.equal(result.metadata?.model, "gemini-3.1-flash-image")
    assert.deepEqual(
      await readFile(join(sessionDirectory, "gemini", "generate.png")),
      ONE_PIXEL_PNG,
    )

    assert.equal(recorder.calls.length, 1)
    assert.match(recorder.calls[0]!.url, /\/interactions$/)
    const headers = recorder.calls[0]!.init.headers as Record<string, string>
    assert.equal(headers["x-goog-api-key"], "sk-test")

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as {
      model: string
      input: Array<Record<string, unknown>>
      response_format?: { mime_type?: string }
    }
    assert.equal(body.model, "gemini-3.1-flash-image")
    assert.equal(body.input.length, 1)
    assert.equal(body.input[0]!.type, "text")
    assert.equal(body.input[0]!.text, "a banana")
    assert.equal(body.response_format?.mime_type, "image/png")
  })

  it("sends every reference image as an image part", async () => {
    await writeFile(join(sessionDirectory, "gemini-reference.png"), ONE_PIXEL_PNG)
    const recorder = recordingFetch(() => jsonResponse(interactionPayload()))
    const tool = buildTool(recorder.fetch)

    await tool.execute(
      {
        prompt: "make it blue",
        outputPath: "gemini/edit.png",
        provider: "gemini",
        referenceImages: ["gemini-reference.png"],
      },
      fakeContext(),
    )

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as {
      input: Array<Record<string, unknown>>
    }
    assert.equal(body.input.length, 2)
    assert.equal(body.input[1]!.type, "image")
    assert.equal(body.input[1]!.mime_type, "image/png")
    assert.equal(body.input[1]!.data, ONE_PIXEL_PNG_BASE64)
  })

  it("rejects an OpenAI-only setting before any request", async () => {
    const recorder = forbiddenFetch()
    const tool = buildTool(recorder.fetch)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "x", outputPath: "gemini/x.png", provider: "gemini", quality: "high" },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(recorder.calls.length, 0)
  })

  it("rejects a webp output path before any request", async () => {
    const recorder = forbiddenFetch()
    const tool = buildTool(recorder.fetch)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "x", outputPath: "gemini/x.webp", provider: "gemini" },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(recorder.calls.length, 0)
  })
})
