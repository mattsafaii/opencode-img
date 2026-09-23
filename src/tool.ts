import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type { Info as ToolInfo, Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool"
import {
  DEFAULT_MODEL,
  OUTPUT_FORMAT_VALUES,
  QUALITY_VALUES,
  reconcileOutputFormat,
  resolveSettings,
} from "./config.ts"
import { ImageToolError, invalidArgument, requireNonEmptyString } from "./errors.ts"
import { SUPPORTED_REFERENCE_EXTENSIONS, mimeTypeForReferencePath } from "./image.ts"
import { createOpenAIImageProvider } from "./openai-provider.ts"
import type { ImageReference } from "./provider.ts"
import { resolveOutputPath, writeImageWithoutOverwrite } from "./paths.ts"

export const TOOL_NAME = "gpt_imagegen"

/**
 * The OpenCode tool context, plus the abort signal newer OpenCode releases pass
 * to promise executors. It is optional so the tool keeps working on releases
 * that do not provide it.
 */
type ToolExecutionContext = ToolContext & { readonly signal?: AbortSignal }

export interface GptImagegenDependencies {
  /** Resolve the OpenCode session directory used as the base for relative paths. */
  resolveSessionDirectory: (sessionID: string) => Promise<string>
  /** Environment source for `OPENAI_API_KEY`; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Resolve a key from OpenCode's OpenAI connection. Consulted only when the
   * option and the environment variable are absent.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Override the OpenAI API base URL. */
  baseUrl?: string
  /** Inject a fetch implementation (used by tests). */
  fetch?: typeof globalThis.fetch
}

/**
 * Find the OpenAI API key, in precedence order: the `OPENAI_API_KEY`
 * environment variable, then OpenCode's OpenAI connection. Fails before any
 * network request when neither is present.
 */
async function resolveApiKey(dependencies: GptImagegenDependencies): Promise<string> {
  const env = dependencies.env ?? process.env
  const fromEnv = env.OPENAI_API_KEY
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv

  const fromConnection = await dependencies.resolveApiKey?.()
  if (typeof fromConnection === "string" && fromConnection !== "") return fromConnection

  throw new ImageToolError(
    "missing_api_key",
    "validate API key",
    "No OpenAI API key was found. Connect OpenAI in OpenCode (run /connect) or set OPENAI_API_KEY.",
  )
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "Text description of the image to generate or the edit to make.",
    },
    outputPath: {
      type: "string",
      description:
        "Where to save the image. Relative paths resolve against the session directory; an existing file is never replaced.",
    },
    model: {
      type: "string",
      description: `OpenAI image model. Defaults to ${DEFAULT_MODEL}.`,
    },
    quality: {
      type: "string",
      enum: [...QUALITY_VALUES],
      description: "Generation quality. Defaults to the model's own default.",
    },
    size: {
      type: "string",
      description: "Image size as WIDTHxHEIGHT, or auto. Defaults to the model's own default.",
    },
    outputFormat: {
      type: "string",
      enum: [...OUTPUT_FORMAT_VALUES],
      description:
        "Output format for GPT image models. Defaults to the format implied by the output path extension.",
    },
    referenceImages: {
      type: "array",
      items: { type: "string" },
      description:
        "Local reference image paths. When present the tool edits them through the OpenAI edits endpoint.",
    },
  },
  required: ["prompt", "outputPath"],
  additionalProperties: false,
} as const

function readReferencePaths(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw invalidArgument("`referenceImages` must be an array of file paths.")
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw invalidArgument("Every `referenceImages` entry must be a file path.")
    }
    return entry
  })
}

async function loadReferences(
  paths: readonly string[],
  sessionDirectory: string,
): Promise<ImageReference[]> {
  const references: ImageReference[] = []
  for (const requested of paths) {
    const filePath = resolveOutputPath(requested, sessionDirectory)
    const mimeType = mimeTypeForReferencePath(filePath)
    if (mimeType === undefined) {
      throw new ImageToolError(
        "invalid_reference",
        "read reference image",
        `Reference image \`${filePath}\` has an unsupported type. Use ${SUPPORTED_REFERENCE_EXTENSIONS.join(", ")}.`,
      )
    }

    let data: Buffer
    try {
      data = await readFile(filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const detail =
        code === "ENOENT" ? "was not found" : `could not be read (${(error as Error).message})`
      throw new ImageToolError(
        "invalid_reference",
        "read reference image",
        `Reference image \`${filePath}\` ${detail}.`,
        { cause: error },
      )
    }

    if (data.byteLength === 0) {
      throw new ImageToolError(
        "invalid_reference",
        "read reference image",
        `Reference image \`${filePath}\` is empty.`,
      )
    }

    references.push({ filename: basename(filePath), mimeType, data })
  }
  return references
}

/**
 * Build the `gpt_imagegen` tool definition.
 *
 * The definition is a plain value so tests can call its `execute` with a fake
 * context, a temporary session directory, and a stubbed fetch implementation.
 */
export function createGptImagegenTool(dependencies: GptImagegenDependencies): ToolInfo {
  return {
    name: TOOL_NAME,
    description:
      "Generate a new bitmap image from a prompt, or edit one from local reference images, using the OpenAI Image API. Saves one image to disk and returns its path.",
    input: INPUT_SCHEMA,
    options: { codemode: true },
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      const apiKey = await resolveApiKey(dependencies)

      const record = (input ?? {}) as Record<string, unknown>
      const prompt = requireNonEmptyString(record.prompt, "prompt")
      const outputPath = requireNonEmptyString(record.outputPath, "outputPath")
      const requestedSettings = resolveSettings({
        model: record.model,
        quality: record.quality,
        size: record.size,
        outputFormat: record.outputFormat,
      })
      const referencePaths = readReferencePaths(record.referenceImages)

      const sessionDirectory = await dependencies.resolveSessionDirectory(context.sessionID)
      const targetPath = resolveOutputPath(outputPath, sessionDirectory)
      const settings = reconcileOutputFormat(requestedSettings, targetPath)
      const references = await loadReferences(referencePaths, sessionDirectory)

      await context.progress({
        status: references.length > 0 ? "editing image" : "generating image",
      })

      const provider = createOpenAIImageProvider({
        apiKey,
        baseUrl: dependencies.baseUrl,
        fetch: dependencies.fetch,
      })

      const result = await provider.generate({ prompt, settings, references }, context.signal)

      if (context.signal?.aborted === true) {
        throw new ImageToolError(
          "cancelled",
          "write image file",
          "The image request was cancelled before the file was written.",
        )
      }

      await context.progress({ status: "writing image" })
      const savedPath = await writeImageWithoutOverwrite(targetPath, result.data)

      const metadata: Record<string, unknown> = {
        path: savedPath,
        model: settings.model,
        mimeType: result.mimeType,
        bytes: result.data.byteLength,
      }
      if (settings.quality !== undefined) metadata.quality = settings.quality
      if (settings.size !== undefined) metadata.size = settings.size
      if (settings.outputFormat !== undefined) metadata.outputFormat = settings.outputFormat
      if (result.revisedPrompt !== undefined) metadata.revisedPrompt = result.revisedPrompt
      if (references.length > 0) metadata.referenceImages = references.map((ref) => ref.filename)

      return {
        content: `Saved image to \`${savedPath}\` (${result.mimeType}, ${result.data.byteLength} bytes).`,
        metadata,
      }
    },
  }
}
