import {
  resolveSettings,
  type GenerationSettings,
  type GenerationSettingsInput,
  type Quality,
} from "./config.ts"
import { invalidArgument } from "./errors.ts"
import { sendJsonRequest } from "./http.ts"
import { decodeImageResponse, mimeTypeForImageBytes } from "./image.ts"
import type {
  ImageProvider,
  ImageProviderOptions,
  ImageReference,
  ImageRequest,
  ImageResult,
} from "./provider.ts"

export const DEFAULT_BASE_URL = "https://api.x.ai/v1"

/** Grok Imagine Image 2.0, the current xAI image model. */
export const GROK_DEFAULT_MODEL = "grok-imagine-image-2.0"

/** Quality values the xAI image model accepts. */
const GROK_QUALITY_VALUES: readonly Quality[] = ["auto", "low", "medium"]

/** Resolve the settings xAI accepts. Size and output format do not apply. */
export function resolveGrokSettings(
  input: GenerationSettingsInput,
  _targetPath: string,
): GenerationSettings {
  const settings = resolveSettings(input, GROK_DEFAULT_MODEL)

  if (settings.size !== undefined) {
    throw invalidArgument("`size` is not supported by the grok provider; xAI uses aspect ratios.")
  }
  if (settings.outputFormat !== undefined) {
    throw invalidArgument("`outputFormat` is not supported by the grok provider.")
  }
  if (settings.quality !== undefined && !GROK_QUALITY_VALUES.includes(settings.quality)) {
    throw invalidArgument(
      `The grok provider accepts quality ${GROK_QUALITY_VALUES.join(", ")}.`,
    )
  }
  return settings
}

function referenceDataUri(reference: ImageReference): string {
  return `data:${reference.mimeType};base64,${Buffer.from(reference.data).toString("base64")}`
}

/**
 * Create the Grok Imagine (xAI) adapter for the internal {@link ImageProvider}
 * seam.
 *
 * Generation posts JSON to `/images/generations`. Editing posts JSON to
 * `/images/edits` with the source images as data URIs; the endpoint does not
 * accept multipart form data.
 */
export function createGrokImageProvider(options: ImageProviderOptions): ImageProvider {
  const apiKey = options.apiKey
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? globalThis.fetch

  function buildBody(request: ImageRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.settings.model,
      prompt: request.prompt,
      n: 1,
      response_format: "b64_json",
    }
    if (request.settings.quality !== undefined) body.quality = request.settings.quality

    const references = request.references ?? []
    if (references.length === 1) {
      body.image = { url: referenceDataUri(references[0]!), type: "image_url" }
    } else if (references.length > 1) {
      body.image = references.map((reference) => ({
        url: referenceDataUri(reference),
        type: "image_url",
      }))
    }
    return body
  }

  async function send(
    request: ImageRequest,
    operation: "generate image" | "edit image",
    signal: AbortSignal | undefined,
  ): Promise<ImageResult> {
    const hasReferences = (request.references?.length ?? 0) > 0
    const url = hasReferences ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`

    const payload = await sendJsonRequest({
      provider: "xAI",
      operation,
      fetchImpl,
      url,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(request)),
      },
      signal,
    })

    const decoded = decodeImageResponse(payload)
    const result: ImageResult = {
      data: decoded.data,
      mimeType: mimeTypeForImageBytes(decoded.data),
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
