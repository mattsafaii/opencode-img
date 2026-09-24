import {
  isGptImageModel,
  outputFormatForExtension,
  reconcileOutputFormat,
  resolveSettings,
  type GenerationSettings,
  type GenerationSettingsInput,
} from "./config.ts"
import { invalidArgument, type ImageToolOperation } from "./errors.ts"
import { sendJsonRequest } from "./http.ts"
import { decodeImageResponse, mimeTypeForOutputFormat } from "./image.ts"
import type { ImageProvider, ImageProviderOptions, ImageRequest, ImageResult } from "./provider.ts"

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"

/** The OpenAI image model used when the caller does not name one. */
export const OPENAI_DEFAULT_MODEL = "gpt-image-1.5"

/**
 * Resolve the generation settings for the OpenAI models.
 *
 * The OpenAI path keeps two model-family rules: an explicit `outputFormat` is
 * rejected for DALL·E, and the output format is reconciled with the output path.
 */
export function resolveOpenAISettings(
  input: GenerationSettingsInput,
  targetPath: string,
): GenerationSettings {
  const settings = resolveSettings(input, OPENAI_DEFAULT_MODEL)

  if (isGptImageModel(settings.model)) {
    return reconcileOutputFormat(settings, targetPath)
  }

  if (settings.outputFormat !== undefined) {
    throw invalidArgument(
      "`outputFormat` is only supported by the GPT image models; DALL·E models always return PNG.",
    )
  }
  const extensionFormat = outputFormatForExtension(targetPath)
  if (extensionFormat !== undefined && extensionFormat !== "png") {
    throw invalidArgument(
      `DALL·E models always return PNG, so \`outputPath\` cannot end in \`.${extensionFormat}\`.`,
    )
  }
  return settings
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

    const payload = await sendJsonRequest({
      provider: "OpenAI",
      operation,
      fetchImpl,
      url,
      init: hasReferences
        ? {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: buildEditForm(request),
          }
        : {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(buildGenerationBody(request)),
          },
      signal,
    })

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
