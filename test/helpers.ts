import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"

/** A minimal valid 1x1 PNG, used as the decoded image in mocked responses. */
export const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

export const ONE_PIXEL_PNG = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")

export interface RecordedCall {
  url: string
  init: RequestInit
}

export interface FetchRecorder {
  fetch: typeof globalThis.fetch
  calls: RecordedCall[]
}

/** A fetch stub that records each call and delegates to `handler`. */
export function recordingFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchRecorder {
  const calls: RecordedCall[] = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const requestInit = (init ?? {}) as RequestInit
    calls.push({ url, init: requestInit })
    return handler(url, requestInit)
  }
  return { fetch: fetchImpl, calls }
}

/** A fetch stub that fails the test if it is called. */
export function forbiddenFetch(): FetchRecorder {
  return recordingFetch(() => {
    throw new Error("fetch must not be called")
  })
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export function generationPayload(
  base64: string = ONE_PIXEL_PNG_BASE64,
): Record<string, unknown> {
  return { created: 1_700_000_000, data: [{ b64_json: base64 }] }
}

/** A fake OpenCode tool context. */
export function fakeContext(
  overrides: Partial<ToolContext> & { signal?: AbortSignal } = {},
): ToolContext & { signal?: AbortSignal } {
  return {
    sessionID: "ses_test" as ToolContext["sessionID"],
    agent: "build" as ToolContext["agent"],
    messageID: "msg_test" as ToolContext["messageID"],
    id: "call_test" as ToolContext["id"],
    progress: async () => {},
    ...overrides,
  }
}

export async function makeTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-img-test-"))
}

export async function removeTempDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}
