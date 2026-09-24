import { isGptImageModel } from "./config.ts"
import { ImageToolError, type ImageToolOperation } from "./errors.ts"
import { decodeImageResponse, mimeTypeForOutputFormat } from "./image.ts"
import type { ImageProvider, ImageProviderOptions, ImageRequest, ImageResult } from "./provider.ts"

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"

const MAX_ERROR_DETAIL = 500

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") || signal?.aborted === true
  )
}

function safeErrorDetail(body: string): string {
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

/**
 * The settings the request carries, as ordered field/value pairs. One mapping
 * feeds both the JSON generation body and the multipart edit form, so adding a
 * setting means editing this list once.
 */
function requestFields(request: ImageRequest): ReadonlyArray<readonly [string, string | number]> {
  const { model, quality, size, outputFormat } = request.settings
  const fields: Array<readonly [string, string | number]> = [
    ["model", model],
    ["prompt", request.prompt],
    ["n", 1],
  ]
  if (quality !== undefined) fields.push(["quality", quality])
  if (size !== undefined) fields.push(["size", size])
  if (isGptImageModel(model)) {
    if (outputFormat !== undefined) fields.push(["output_format", outputFormat])
  } else {
    // DALL·E models default to a URL; ask for base64 so one decode path serves both.
    fields.push(["response_format", "b64_json"])
  }
  return fields
}

function buildGenerationBody(request: ImageRequest): Record<string, unknown> {
  return Object.fromEntries(requestFields(request))
}

function buildEditForm(request: ImageRequest): FormData {
  const form = new FormData()
  for (const [key, value] of requestFields(request)) form.set(key, String(value))
  for (const reference of request.references ?? []) {
    const blob = new Blob([reference.data], { type: reference.mimeType })
    form.append("image[]", blob, reference.filename)
  }
  return form
}

/**
 * Create the OpenAI adapter for the internal {@link ImageProvider} seam.
 *
 * With no reference images the request goes to `/images/generations` as JSON.
 * With reference images it becomes a multipart request to `/images/edits` and
 * every image is attached under the `image[]` field.
 */
export function createOpenAIImageProvider(options: ImageProviderOptions): ImageProvider {
  const apiKey = options.apiKey
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? globalThis.fetch

  async function send(
    request: ImageRequest,
    operation: ImageToolOperation,
    signal: AbortSignal | undefined,
  ): Promise<ImageResult> {
    const hasReferences = (request.references?.length ?? 0) > 0
    const url = hasReferences ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`

    let response: Response
    try {
      response = hasReferences
        ? await fetchImpl(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: buildEditForm(request),
            signal,
          })
        : await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(buildGenerationBody(request)),
            signal,
          })
    } catch (error) {
      if (isAbort(error, signal)) {
        throw new ImageToolError("cancelled", operation, "The image request was cancelled.", {
          cause: error,
        })
      }
      throw new ImageToolError(
        "api_error",
        operation,
        `Could not reach OpenAI while trying to ${operation}: ${(error as Error).message}.`,
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = safeErrorDetail(await response.text().catch(() => ""))
      throw new ImageToolError(
        "api_error",
        operation,
        `OpenAI returned HTTP ${response.status} while trying to ${operation}: ${detail}`,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ImageToolError(
        "malformed_response",
        operation,
        "OpenAI returned a response body that was not valid JSON.",
        { cause: error },
      )
    }

    const decoded = decodeImageResponse(payload)
    const result: ImageResult = {
      data: decoded.data,
      mimeType: mimeTypeForOutputFormat(request.settings.outputFormat),
    }
    if (decoded.revisedPrompt !== undefined) result.revisedPrompt = decoded.revisedPrompt
    return result
  }

  return {
    generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
      const hasReferences = (request.references?.length ?? 0) > 0
      return send(request, hasReferences ? "edit image" : "generate image", signal)
    },
  }
}
