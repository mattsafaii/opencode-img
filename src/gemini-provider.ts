import {
  reconcileOutputFormat,
  resolveSettings,
  type GenerationSettings,
  type GenerationSettingsInput,
  type OutputFormat,
} from "./config.ts"
import { ImageToolError, invalidArgument } from "./errors.ts"
import { sendJsonRequest } from "./http.ts"
import { decodeBase64Image, mimeTypeForOutputFormat } from "./image.ts"
import type { ImageProvider, ImageProviderOptions, ImageRequest, ImageResult } from "./provider.ts"

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

/** Nano Banana 2, the generalist Gemini image model. */
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-image"

/** Output formats the Gemini image models can produce. */
const SUPPORTED_OUTPUT_FORMATS: readonly OutputFormat[] = ["png", "jpeg"]

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
    !SUPPORTED_OUTPUT_FORMATS.includes(reconciled.outputFormat)
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
    if (request.settings.outputFormat !== undefined) {
      body.response_format = {
        type: "image",
        mime_type: mimeTypeForOutputFormat(request.settings.outputFormat),
      }
    }
    return body
  }

  async function send(
    request: ImageRequest,
    operation: "generate image" | "edit image",
    signal: AbortSignal | undefined,
  ): Promise<ImageResult> {
    const payload = await sendJsonRequest({
      provider: "Gemini",
      operation,
      fetchImpl,
      url: `${baseUrl}/interactions`,
      init: {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(request)),
      },
      signal,
    })

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
