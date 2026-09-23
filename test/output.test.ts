import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { resolveOutputPath } from "../src/paths.ts"
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

describe("output settings and path handling", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  it("resolves relative paths against the session directory", () => {
    assert.equal(resolveOutputPath("out/pixel.png", sessionDirectory), join(sessionDirectory, "out/pixel.png"))
    assert.equal(resolveOutputPath("./pixel.png", sessionDirectory), join(sessionDirectory, "pixel.png"))
  })

  it("keeps absolute paths absolute", () => {
    const absolute = resolve(sessionDirectory, "absolute/pixel.png")
    assert.equal(resolveOutputPath(absolute, "/some/other/directory"), absolute)
  })

  it("passes model, quality, size, and output format to the generation request", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    const result = await tool.execute(
      {
        prompt: "a wide pixel",
        outputPath: "configured.webp",
        model: "gpt-image-1.5",
        quality: "high",
        size: "1536x1024",
        outputFormat: "webp",
      },
      fakeContext(),
    )

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.model, "gpt-image-1.5")
    assert.equal(body.quality, "high")
    assert.equal(body.size, "1536x1024")
    assert.equal(body.output_format, "webp")
    assert.equal(result.metadata?.mimeType, "image/webp")
  })

  it("passes settings to the edit request and asks for base64 from DALL·E", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })
    await writeFile(join(sessionDirectory, "reference.png"), ONE_PIXEL_PNG)

    await tool.execute(
      {
        prompt: "edit the pixel",
        outputPath: "edited.jpg",
        model: "gpt-image-1.5",
        quality: "low",
        size: "1024x1024",
        outputFormat: "jpeg",
        referenceImages: ["reference.png"],
      },
      fakeContext(),
    )

    const form = recorder.calls[0]!.init.body as FormData
    assert.equal(form.get("quality"), "low")
    assert.equal(form.get("size"), "1024x1024")
    assert.equal(form.get("output_format"), "jpeg")
  })

  it("infers the output format from the path extension", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    await tool.execute({ prompt: "a pixel", outputPath: "inferred.webp" }, fakeContext())

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.output_format, "webp")
  })

  it("rejects an output format that conflicts with the path extension", async () => {
    const recorder = forbiddenFetch()
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "a pixel", outputPath: "mismatch.png", outputFormat: "webp" },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(recorder.calls.length, 0)
  })

  it("asks DALL·E for base64 instead of an output format", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    await tool.execute(
      { prompt: "a pixel", outputPath: "dalle.png", model: "dall-e-3" },
      fakeContext(),
    )

    const body = JSON.parse(String(recorder.calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.response_format, "b64_json")
    assert.equal(body.output_format, undefined)
  })

  it("rejects an output format for DALL·E models before any request", async () => {
    const recorder = forbiddenFetch()
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "a pixel", outputPath: "dalle.png", model: "dall-e-3", outputFormat: "jpeg" },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_argument",
    )
    assert.equal(recorder.calls.length, 0)
  })

  it("never replaces an existing file and uses the next version", async () => {
    const target = join(sessionDirectory, "versioned.png")
    await writeFile(target, Buffer.from("original"))

    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })

    const result = await tool.execute(
      { prompt: "a pixel", outputPath: "versioned.png" },
      fakeContext(),
    )

    assert.equal(result.metadata?.path, join(sessionDirectory, "versioned-1.png"))
    assert.deepEqual(await readFile(target), Buffer.from("original"))
    assert.deepEqual(await readFile(join(sessionDirectory, "versioned-1.png")), ONE_PIXEL_PNG)

    const second = await tool.execute(
      { prompt: "another pixel", outputPath: "versioned.png" },
      fakeContext(),
    )
    assert.equal(second.metadata?.path, join(sessionDirectory, "versioned-2.png"))
    assert.deepEqual(await readFile(target), Buffer.from("original"))
  })
})
