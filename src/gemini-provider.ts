import {
  reconcileOutputFormat,
  resolveSettings,
  type GenerationSettings,
  type GenerationSettingsInput,
} from "./config.ts"
import { ImageToolError, invalidArgument, type ImageToolOperation } from "./errors.ts"
import { isAbort, safeErrorDetail } from "./http.ts"
import { decodeBase64Image } from "./image.ts"
import type { ImageProvider, ImageProviderOptions, ImageRequest, ImageResult } from "./provider.ts"

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

/** Nano Banana 2, the generalist Gemini image model. */
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-image"

const MIME_BY_OUTPUT_FORMAT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
}

/** Resolve the settings Gemini accepts. Quality, size, and webp do not apply. */
export function resolveGeminiSettings(
  input: GenerationSettingsInput,
  targetPath: string,
): GenerationSettings {
  const settings = resolveSettings(input, GEMINI_DEFAULT_MODEL)

  if (settings.quality !== undefined) {
    throw invalidArgument("`quality` is not supported by the gemini provider.")
  }
  if (settings.size !== undefined) {
    throw invalidArgument("`size` is not supported by the gemini provider; Gemini uses aspect ratios.")
  }

  const reconciled = reconcileOutputFormat(settings, targetPath)
  if (
    reconciled.outputFormat !== undefined &&
    MIME_BY_OUTPUT_FORMAT[reconciled.outputFormat] === undefined
  ) {
    throw invalidArgument(
      `The gemini provider cannot produce ${reconciled.outputFormat}; use png or jpeg.`,
    )
  }
  return reconciled
}

interface ImageBlock {
  data: string
  mimeType: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function imageBlockFrom(value: unknown): ImageBlock | undefined {
  const block = asRecord(value)
  if (block === undefined) return undefined
  if (block.type !== undefined && block.type !== "image") return undefined

  const data = block.data
  if (typeof data !== "string" || data === "") return undefined

  const mimeType =
    typeof block.mime_type === "string"
      ? block.mime_type
      : typeof block.mimeType === "string"
        ? block.mimeType
        : "image/png"
  return { data, mimeType }
}

/** Find the last image block in an Interactions response. */
function findImage(payload: unknown): ImageBlock | undefined {
  const root = asRecord(payload)
  if (root === undefined) return undefined

  const direct = imageBlockFrom(root.output_image ?? root.outputImage)
  if (direct !== undefined) return direct

  const steps = root.steps
  if (!Array.isArray(steps)) return undefined

  let found: ImageBlock | undefined
  for (const step of steps) {
    const content = asRecord(step)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const image = imageBlockFrom(block)
      if (image !== undefined) found = image
    }
  }
  return found
}

/**
 * Create the Gemini (Nano Banana) adapter for the internal {@link ImageProvider}
 * seam.
 *
 * Generation and editing use one endpoint. The prompt and every reference image
 * travel together as content parts, and the generated image comes back in the
 * response steps.
 */
export function createGeminiImageProvider(options: ImageProviderOptions): ImageProvider {
  const apiKey = options.apiKey
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? globalThis.fetch

  function buildBody(request: ImageRequest): Record<string, unknown> {
    const input: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }]
    for (const reference of request.references ?? []) {
      input.push({
        type: "image",
        mime_type: reference.mimeType,
        data: Buffer.from(reference.data).toString("base64"),
      })
    }

    const body: Record<string, unknown> = { model: request.settings.model, input }
    const mimeType =
      request.settings.outputFormat === undefined
        ? undefined
        : MIME_BY_OUTPUT_FORMAT[request.settings.outputFormat]
    if (mimeType !== undefined) {
      body.response_format = { type: "image", mime_type: mimeType }
    }
    return body
  }

  async function send(
    request: ImageRequest,
    operation: ImageToolOperation,
    signal: AbortSignal | undefined,
  ): Promise<ImageResult> {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/interactions`, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(request)),
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
        `Could not reach Gemini while trying to ${operation}: ${(error as Error).message}.`,
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = safeErrorDetail(await response.text().catch(() => ""))
      throw new ImageToolError(
        "api_error",
        operation,
        `Gemini returned HTTP ${response.status} while trying to ${operation}: ${detail}`,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ImageToolError(
        "malformed_response",
        operation,
        "Gemini returned a response body that was not valid JSON.",
        { cause: error },
      )
    }

    const image = findImage(payload)
    if (image === undefined) {
      throw new ImageToolError(
        "malformed_response",
        "decode image response",
        "The image response could not be read: the response contained no image.",
      )
    }

    return { data: decodeBase64Image(image.data), mimeType: image.mimeType }
  }

  return {
    generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
      const hasReferences = (request.references?.length ?? 0) > 0
      return send(request, hasReferences ? "edit image" : "generate image", signal)
    },
  }
}
