import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
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

describe("gpt_imagegen edit", () => {
  let sessionDirectory: string

  before(async () => {
    sessionDirectory = await makeTempDirectory()
    await mkdir(join(sessionDirectory, "refs"), { recursive: true })
    await writeFile(join(sessionDirectory, "refs", "one.png"), ONE_PIXEL_PNG)
    await writeFile(join(sessionDirectory, "refs", "two.png"), ONE_PIXEL_PNG)
    await writeFile(join(sessionDirectory, "refs", "notes.txt"), "not an image")
    await writeFile(join(sessionDirectory, "refs", "empty.png"), Buffer.alloc(0))
  })

  after(async () => {
    await removeTempDirectory(sessionDirectory)
  })

  function toolWith(recorder: ReturnType<typeof recordingFetch>) {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: recorder.fetch,
    })
  }

  it("sends every reference image to the edits endpoint and saves the result", async () => {
    const recorder = recordingFetch(() => jsonResponse(generationPayload()))
    const tool = toolWith(recorder)

    const result = await tool.execute(
      {
        prompt: "blend the two reference pixels",
        outputPath: "edited/result.png",
        referenceImages: ["refs/one.png", "refs/two.png"],
      },
      fakeContext(),
    )

    const expectedPath = join(sessionDirectory, "edited", "result.png")
    assert.equal(result.metadata?.path, expectedPath)
    assert.deepEqual(await readFile(expectedPath), ONE_PIXEL_PNG)

    assert.equal(recorder.calls.length, 1)
    assert.match(recorder.calls[0]!.url, /\/images\/edits$/)
    const form = recorder.calls[0]!.init.body as FormData
    assert.ok(form instanceof FormData)
    assert.equal(form.get("model"), "gpt-image-1.5")
    assert.equal(form.get("prompt"), "blend the two reference pixels")
    assert.equal(form.get("n"), "1")

    const images = form.getAll("image[]")
    assert.equal(images.length, 2)
    const names = images.map((entry) => (entry as File).name)
    assert.deepEqual(names.sort(), ["one.png", "two.png"])
    for (const entry of images) {
      assert.equal((entry as File).type, "image/png")
      assert.deepEqual(Buffer.from(await (entry as File).arrayBuffer()), ONE_PIXEL_PNG)
    }
  })

  it("rejects an unsupported reference type before calling OpenAI", async () => {
    const recorder = forbiddenFetch()
    const tool = toolWith(recorder)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "edit", outputPath: "out.png", referenceImages: ["refs/notes.txt"] },
          fakeContext(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ImageToolError)
        assert.equal(error.code, "invalid_reference")
        assert.match(error.message, /notes\.txt/)
        return true
      },
    )
    assert.equal(recorder.calls.length, 0)
  })

  it("rejects a missing reference file before calling OpenAI", async () => {
    const recorder = forbiddenFetch()
    const tool = toolWith(recorder)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "edit", outputPath: "out.png", referenceImages: ["refs/missing.png"] },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_reference",
    )
    assert.equal(recorder.calls.length, 0)
  })

  it("rejects an empty reference file before calling OpenAI", async () => {
    const recorder = forbiddenFetch()
    const tool = toolWith(recorder)

    await assert.rejects(
      () =>
        tool.execute(
          { prompt: "edit", outputPath: "out.png", referenceImages: ["refs/empty.png"] },
          fakeContext(),
        ),
      (error: unknown) => error instanceof ImageToolError && error.code === "invalid_reference",
    )
    assert.equal(recorder.calls.length, 0)
  })
})
