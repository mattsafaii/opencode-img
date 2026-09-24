import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import plugin from "../src/index.ts"
import { createGptImagegenTool } from "../src/tool.ts"
import {
  ONE_PIXEL_PNG,
  ONE_PIXEL_PNG_BASE64,
  fakeContext,
  generationPayload,
  makeTempDirectory,
  removeTempDirectory,
} from "./helpers.ts"

interface RecordedRequest {
  url: string | undefined
  headers: IncomingMessage["headers"]
  body: Buffer
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe("core flow end to end", () => {
  let sessionDirectory: string
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  const requests: RecordedRequest[] = []

  before(async () => {
    sessionDirectory = await makeTempDirectory()
    server = createServer(async (request, response) => {
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await readBody(request),
      })
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify(generationPayload()))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}/v1`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeTempDirectory(sessionDirectory)
  })

  function buildTool() {
    return createGptImagegenTool({
      resolveSessionDirectory: async () => sessionDirectory,
      env: { OPENAI_API_KEY: "sk-e2e" },
      baseUrl,
    })
  }

  it("generates an image over real HTTP and writes it to disk", async () => {
    requests.length = 0
    const tool = buildTool()

    const result = await tool.execute(
      { prompt: "an end to end pixel", outputPath: "e2e/generated.png" },
      fakeContext(),
    )

    const saved = join(sessionDirectory, "e2e", "generated.png")
    assert.equal(result.metadata?.path, saved)
    assert.deepEqual(await readFile(saved), ONE_PIXEL_PNG)

    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, "/v1/images/generations")
    assert.equal(requests[0]!.headers.authorization, "Bearer sk-e2e")
    const body = JSON.parse(requests[0]!.body.toString("utf8")) as Record<string, unknown>
    assert.equal(body.prompt, "an end to end pixel")
  })

  it("edits an image over real multipart HTTP and writes the result", async () => {
    requests.length = 0
    await writeFile(join(sessionDirectory, "e2e-reference.png"), ONE_PIXEL_PNG)
    const tool = buildTool()

    const result = await tool.execute(
      {
        prompt: "edit the end to end pixel",
        outputPath: "e2e/edited.png",
        referenceImages: ["e2e-reference.png"],
      },
      fakeContext(),
    )

    const saved = join(sessionDirectory, "e2e", "edited.png")
    assert.equal(result.metadata?.path, saved)
    assert.deepEqual(await readFile(saved), ONE_PIXEL_PNG)

    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, "/v1/images/edits")
    assert.match(String(requests[0]!.headers["content-type"]), /^multipart\/form-data; boundary=/)
    const raw = requests[0]!.body
    assert.ok(raw.includes(Buffer.from('name="image[]"')))
    assert.ok(raw.includes(Buffer.from('filename="e2e-reference.png"')))
    assert.ok(raw.includes(ONE_PIXEL_PNG))
  })

  function fakePluginContext(options: {
    directory: string
    connection?: { active: boolean; credential?: unknown }
    pluginOptions?: Record<string, unknown>
  }) {
    let registered: ToolInfo | undefined
    const context = {
      options: options.pluginOptions ?? {},
      tool: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (tool: ToolInfo) => {
              registered = tool
            },
            list: () => [],
            get: () => undefined,
            namespace: () => {},
            update: () => {},
            remove: () => {},
          })
          return { dispose: async () => {} }
        },
      },
      session: {
        get: async () => ({ location: { directory: options.directory } }),
      },
      integration: {
        connection: {
          active: async () =>
            options.connection?.active ? { type: "credential", id: "cred", label: "API key" } : undefined,
          resolve: async () => options.connection?.credential,
        },
      },
    }
    return { context, getTool: () => registered }
  }

  it("registers the gpt_imagegen tool during plugin setup", async () => {
    const { context, getTool } = fakePluginContext({ directory: sessionDirectory })

    await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0])

    const registered = getTool()
    assert.ok(registered, "setup should register a tool")
    assert.equal(registered!.name, "gpt_imagegen")
    assert.equal(typeof registered!.execute, "function")
  })

  it("resolves the OpenAI key from the OpenCode connection during setup", async () => {
    const { context, getTool } = fakePluginContext({
      directory: sessionDirectory,
      connection: { active: true, credential: { type: "key", key: "sk-from-connection" } },
    })

    await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0])
    const tool = getTool()
    assert.ok(tool)

    const realFetch = globalThis.fetch
    const calls: RequestInit[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify(generationPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof globalThis.fetch

    try {
      await tool!.execute({ prompt: "a pixel", outputPath: "from-connection.png" }, fakeContext())
    } finally {
      globalThis.fetch = realFetch
    }

    const headers = calls[0]!.headers as Record<string, string>
    assert.equal(headers.Authorization, "Bearer sk-from-connection")
  })

  it("reads the provider and model options during setup", async () => {
    const { context, getTool } = fakePluginContext({
      directory: sessionDirectory,
      connection: { active: true, credential: { type: "key", key: "gm-from-connection" } },
      pluginOptions: {
        provider: "gemini",
        models: { gemini: "gemini-3.1-flash-image-preview" },
      },
    })

    await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0])
    const tool = getTool()
    assert.ok(tool)

    const realFetch = globalThis.fetch
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(
        JSON.stringify({
          steps: [
            {
              type: "model_output",
              content: [{ type: "image", mime_type: "image/png", data: ONE_PIXEL_PNG_BASE64 }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof globalThis.fetch

    try {
      await tool!.execute({ prompt: "a pixel", outputPath: "from-options.png" }, fakeContext())
    } finally {
      globalThis.fetch = realFetch
    }

    assert.match(calls[0]!.url, /\/interactions$/)
    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers["x-goog-api-key"], "gm-from-connection")
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body.model, "gemini-3.1-flash-image-preview")
  })
})
