import { extname } from "node:path"
import { invalidArgument, requireNonEmptyString } from "./errors.ts"

/** The OpenAI image model used when the caller does not name one. */
export const DEFAULT_MODEL = "gpt-image-1.5"

/** Quality values accepted by the OpenAI Images API. */
export const QUALITY_VALUES = [
  "auto",
  "standard",
  "hd",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

/** Output formats accepted by the GPT image models. */
export const OUTPUT_FORMAT_VALUES = ["png", "jpeg", "webp"] as const

export type Quality = (typeof QUALITY_VALUES)[number]
export type OutputFormat = (typeof OUTPUT_FORMAT_VALUES)[number]

export interface GenerationSettings {
  model: string
  quality?: Quality
  size?: string
  outputFormat?: OutputFormat
}

export interface GenerationSettingsInput {
  model?: unknown
  quality?: unknown
  size?: unknown
  outputFormat?: unknown
}

/** True when the model is one of the GPT image models rather than a DALL·E model. */
export function isGptImageModel(model: string): boolean {
  return !model.startsWith("dall-e")
}

/**
 * The output format implied by a path's extension, or `undefined` when the
 * extension is absent or not one the API produces.
 */
export function outputFormatForExtension(filePath: string): OutputFormat | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "png"
    case ".jpg":
    case ".jpeg":
      return "jpeg"
    case ".webp":
      return "webp"
    default:
      return undefined
  }
}

/**
 * Validate the optional generation settings and apply the provider's default
 * model.
 *
 * Size is checked as a shape (`auto` or `WIDTHxHEIGHT`) rather than a fixed
 * list so newer models that accept arbitrary resolutions keep working.
 */
export function resolveSettings(
  input: GenerationSettingsInput,
  defaultModel: string = DEFAULT_MODEL,
): GenerationSettings {
  const model =
    input.model === undefined ? defaultModel : requireNonEmptyString(input.model, "model")

  const settings: GenerationSettings = { model }

  if (input.quality !== undefined) {
    const quality = requireNonEmptyString(input.quality, "quality")
    if (!QUALITY_VALUES.includes(quality as Quality)) {
      throw invalidArgument(`\`quality\` must be one of ${QUALITY_VALUES.join(", ")}.`)
    }
    settings.quality = quality as Quality
  }

  if (input.size !== undefined) {
    const size = requireNonEmptyString(input.size, "size")
    if (size !== "auto" && !/^\d+x\d+$/.test(size)) {
      throw invalidArgument(
        "`size` must be `auto` or a `WIDTHxHEIGHT` string such as `1024x1024`.",
      )
    }
    settings.size = size
  }

  if (input.outputFormat !== undefined) {
    const outputFormat = requireNonEmptyString(input.outputFormat, "outputFormat")
    if (!OUTPUT_FORMAT_VALUES.includes(outputFormat as OutputFormat)) {
      throw invalidArgument(`\`outputFormat\` must be one of ${OUTPUT_FORMAT_VALUES.join(", ")}.`)
    }
    if (!isGptImageModel(model)) {
      throw invalidArgument(
        "`outputFormat` is only supported by the GPT image models; DALL·E models always return PNG.",
      )
    }
    settings.outputFormat = outputFormat as OutputFormat
  }

  return settings
}

/**
 * Keep the encoded format and the output filename in agreement.
 *
 * An explicit `outputFormat` must match a known image extension on the path.
 * When the format is omitted, a known extension selects it so the bytes never
 * contradict the name. DALL·E models can only produce PNG.
 */
export function reconcileOutputFormat(
  settings: GenerationSettings,
  targetPath: string,
): GenerationSettings {
  const extensionFormat = outputFormatForExtension(targetPath)
  if (extensionFormat === undefined) return settings

  if (settings.outputFormat !== undefined) {
    if (settings.outputFormat !== extensionFormat) {
      throw invalidArgument(
        `\`outputFormat\` is \`${settings.outputFormat}\` but \`outputPath\` ends in \`.${extensionFormat}\`. Align them or drop \`outputFormat\`.`,
      )
    }
    return settings
  }

  if (!isGptImageModel(settings.model)) {
    if (extensionFormat !== "png") {
      throw invalidArgument(
        `DALL·E models always return PNG, so \`outputPath\` cannot end in \`.${extensionFormat}\`.`,
      )
    }
    return settings
  }

  return { ...settings, outputFormat: extensionFormat }
}
