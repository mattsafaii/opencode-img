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

function grokPayload(base64: string = ONE_PIXEL_PNG_BASE64): Record<string, unknown> {
  return { id: "img_gen_test", data: [{ b64_json: base64 }] }
}

describe("gpt_imagegen grok provider", () => {
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
      env: { XAI_API_KEY: "xai-test" },
      fetch: fetchImpl,
    })
  }

  it("generates through the xAI images endpoint", async () => {
    const recorder = recordingFetch(() => jsonResponse(grokPayload()))
    const tool = buildTool(recorder.fetch)

    const result = await tool.execute(
      { prompt: "a rocket", outputPath: "grok/generate.png", provider: "grok" },
      fakeContext(),
    )

    assert.equal(result.metadata?.provider, "grok")
    assert.equal(result.metadata?.model, "grok-imagine-image-2.0")
    assert.equal(result.metadata?.mimeType, "image/png")
    assert.deepEqual(
      await readFile(join(sessionDirectory, "grok", "generate.png")),
      ONE_PIXEL_PNG,
    )

    assert.equal(recorder.calls.length, 1)
    assert.match(recorder.calls[0]!.url, /\/images\/generations$/)
    const headers = recorder.calls[0]!.init.headers as Record<string, string>
    assert.equal(headers.Authorization, "Bearer xai-test")

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.model, "grok-imagine-image-2.0")
    assert.equal(body.prompt, "a rocket")
    assert.equal(body.n, 1)
    assert.equal(body.response_format, "b64_json")
    assert.equal(body.image, undefined)
  })

  it("edits through the JSON edits endpoint with a data URI", async () => {
    await writeFile(join(sessionDirectory, "grok-reference.png"), ONE_PIXEL_PNG)
    const recorder = recordingFetch(() => jsonResponse(grokPayload()))
    const tool = buildTool(recorder.fetch)

    await tool.execute(
      {
        prompt: "make it night",
        outputPath: "grok/edit.png",
        provider: "grok",
        referenceImages: ["grok-reference.png"],
      },
      fakeContext(),
    )

    assert.match(recorder.calls[0]!.url, /\/images\/edits$/)
    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as {
      image: { url?: string; type?: string }
    }
    assert.equal(body.image.type, "image_url")
    assert.equal(body.image.url, `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`)
  })

  it("sends multiple references as an array", async () => {
    await writeFile(join(sessionDirectory, "grok-two.png"), ONE_PIXEL_PNG)
    const recorder = recordingFetch(() => jsonResponse(grokPayload()))
    const tool = buildTool(recorder.fetch)

    await tool.execute(
      {
        prompt: "combine them",
        outputPath: "grok/combine.png",
        provider: "grok",
        referenceImages: ["grok-reference.png", "grok-two.png"],
      },
      fakeContext(),
    )

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as { image: unknown[] }
    assert.ok(Array.isArray(body.image))
    assert.equal(body.image.length, 2)
  })

  it("rejects size, outputFormat, and an unsupported quality before any request", async () => {
    for (const input of [
      { size: "1024x1024" },
      { outputFormat: "png" },
      { quality: "high" },
    ]) {
      const recorder = forbiddenFetch()
      const tool = buildTool(recorder.fetch)
      await assert.rejects(
        () => tool.execute({ prompt: "x", outputPath: "grok/x.png", provider: "grok", ...input }, fakeContext()),
        (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
      )
      assert.equal(recorder.calls.length, 0)
    }
  })
})
