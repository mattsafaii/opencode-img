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
