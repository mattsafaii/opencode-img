import { ImageToolError, type ImageToolOperation } from "./errors.ts"

const MAX_ERROR_DETAIL = 500

/** True when a fetch failure is an abort rather than a real error. */
export function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (error instanceof Error && error.name === "AbortError") || signal?.aborted === true
}

/** A short, safe detail string pulled from an error response body. */
export function safeErrorDetail(body: string): string {
  const trimmed = body.trim()
  if (trimmed === "") return "no response body"
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === "string" && message !== "") {
      return message.slice(0, MAX_ERROR_DETAIL)
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return trimmed.slice(0, MAX_ERROR_DETAIL)
}

export interface JsonRequest {
  /** Provider name used in error messages, for example `OpenAI`. */
  provider: string
  operation: ImageToolOperation
  fetchImpl: typeof globalThis.fetch
  url: string
  init: RequestInit
  signal: AbortSignal | undefined
}

/**
 * Send a JSON request and return the parsed body.
 *
 * Shared by every adapter so the failure semantics stay identical: an abort is a
 * cancellation, a non-OK status is an API error carrying the status and a
 * bounded detail, and an unreadable body is a malformed response.
 */
export async function sendJsonRequest(request: JsonRequest): Promise<unknown> {
  let response: Response
  try {
    response = await request.fetchImpl(request.url, { ...request.init, signal: request.signal })
  } catch (error) {
    if (isAbort(error, request.signal)) {
      throw new ImageToolError("cancelled", request.operation, "The image request was cancelled.", {
        cause: error,
      })
    }
    throw new ImageToolError(
      "api_error",
      request.operation,
      `Could not reach ${request.provider} while trying to ${request.operation}: ${(error as Error).message}.`,
      { cause: error },
    )
  }

  if (!response.ok) {
    const detail = safeErrorDetail(await response.text().catch(() => ""))
    throw new ImageToolError(
      "api_error",
      request.operation,
      `${request.provider} returned HTTP ${response.status} while trying to ${request.operation}: ${detail}`,
    )
  }

  try {
    return await response.json()
  } catch (error) {
    throw new ImageToolError(
      "malformed_response",
      request.operation,
      `${request.provider} returned a response body that was not valid JSON.`,
      { cause: error },
    )
  }
}
