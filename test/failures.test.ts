import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { ImageToolError } from "../src/errors.ts"
import { createGptImagegenTool } from "../src/tool.ts"
import {
  fakeContext,
  generationPayload,
  jsonResponse,
  makeTempDirectory,
  recordingFetch,
  removeTempDirectory,
} from "./helpers.ts"

const API_KEY = "sk-test-secret-value"

describe("gpt_imagegen failure handling", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  function toolWith(fetchImpl: typeof globalThis.fetch) {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: API_KEY },
      fetch: fetchImpl,
    })
  }

  function outputPath(name: string): string {
    return join(sessionDirectory, name)
  }

  it("reports an API error with status and operation, without leaking the key or writing a file", async () => {
    const recorder = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Incorrect API key provided." } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    )
    const tool = toolWith(recorder.fetch)
    const target = outputPath("api-error.png")

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "api-error.png" }, fakeContext()),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "api_error")
        assert.match(error.message, /HTTP 401/)
        assert.match(error.message, /generate image/)
        assert.ok(!error.message.includes(API_KEY))
        return true
      },
    )
    assert.ok(!existsSync(target))
  })

  it("reports a network failure without writing a file", async () => {
    const recorder = recordingFetch(() => {
      throw new Error("connection refused")
    })
    const tool = toolWith(recorder.fetch)
    const target = outputPath("network-error.png")

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "network-error.png" }, fakeContext()),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "api_error")
        assert.match(error.message, /Could not reach OpenAI/)
        assert.ok(!error.message.includes(API_KEY))
        return true
      },
    )
    assert.ok(!existsSync(target))
  })

  it("rejects malformed base64 image data without writing a file", async () => {
    const recorder = recordingFetch(() => jsonResponse({ created: 1, data: [{ b64_json: "!!!" }] }))
    const tool = toolWith(recorder.fetch)
    const target = outputPath("malformed.png")

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "malformed.png" }, fakeContext()),
      (error: unknown) => error instanceof ImageToolError && error.code === "malformed_response",
    )
    assert.ok(!existsSync(target))
  })

  it("rejects a response with no image data", async () => {
    const recorder = recordingFetch(() => jsonResponse({ created: 1, data: [] }))
    const tool = toolWith(recorder.fetch)

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "empty.png" }, fakeContext()),
      (error: unknown) => error instanceof ImageToolError && error.code === "malformed_response",
    )
    assert.ok(!existsSync(outputPath("empty.png")))
  })

  it("rejects a response body that is not JSON", async () => {
    const recorder = recordingFetch(() => new Response("not json", { status: 200 }))
    const tool = toolWith(recorder.fetch)

    await assert.rejects(
      () => tool.execute({ prompt: "a pixel", outputPath: "not-json.png" }, fakeContext()),
      (error: unknown) => error instanceof ImageToolError && error.code === "malformed_response",
    )
    assert.ok(!existsSync(outputPath("not-json.png")))
  })

  it("stops cleanly when the request is cancelled and writes no file", async () => {
    const controller = new AbortController()
    const recorder = recordingFetch(() => {
      controller.abort()
      throw new DOMException("The operation was aborted.", "AbortError")
    })
    const tool = toolWith(recorder.fetch)
    const target = outputPath("cancelled.png")

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "a pixel", outputPath: "cancelled.png" },
          fakeContext({ signal: controller.signal }),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "cancelled",
    )
    assert.ok(!existsSync(target))
  })

  it("stops before writing when cancellation arrives after the response", async () => {
    const controller = new AbortController()
    const recorder = recordingFetch(() => {
      controller.abort()
      return jsonResponse(generationPayload())
    })
    const tool = toolWith(recorder.fetch)
    const target = outputPath("cancelled-late.png")

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "a pixel", outputPath: "cancelled-late.png" },
          fakeContext({ signal: controller.signal }),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "cancelled",
    )
    assert.ok(!existsSync(target))
  })
})
