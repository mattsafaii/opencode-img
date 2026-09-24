import { DEFAULT_MODEL, type GenerationSettings, type GenerationSettingsInput } from "./config.ts"
import { invalidArgument } from "./errors.ts"
import {
  GEMINI_DEFAULT_MODEL,
  createGeminiImageProvider,
  resolveGeminiSettings,
} from "./gemini-provider.ts"
import { createOpenAIImageProvider, resolveOpenAISettings } from "./openai-provider.ts"
import type { ImageProvider, ImageProviderOptions } from "./provider.ts"

/** The provider used when the caller does not name one. */
export const DEFAULT_PROVIDER = "openai"

export interface ImageProviderDefinition {
  /** The id used in the tool's `provider` input. */
  readonly id: string
  /** The model used when the caller does not name one. */
  readonly defaultModel: string
  /** Environment variables that can supply the key, checked in order. */
  readonly envVars: readonly string[]
  /** OpenCode integration id whose connection can supply the key. */
  readonly integrationID: string
  /** Validate the request settings and reconcile the output format with the path. */
  readonly resolveSettings: (
    input: GenerationSettingsInput,
    targetPath: string,
  ) => GenerationSettings
  /** Build the adapter for this provider. */
  readonly create: (options: ImageProviderOptions) => ImageProvider
}

/**
 * The internal provider registry.
 *
 * It stays private to the package. The tool routes to an entry here, and adding
 * a service means adding an entry, not exposing a public plugin API.
 */
const PROVIDERS: Readonly<Record<string, ImageProviderDefinition>> = {
  openai: {
    id: "openai",
    defaultModel: DEFAULT_MODEL,
    envVars: ["OPENAI_API_KEY"],
    integrationID: "openai",
    resolveSettings: resolveOpenAISettings,
    create: createOpenAIImageProvider,
  },
  gemini: {
    id: "gemini",
    defaultModel: GEMINI_DEFAULT_MODEL,
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    integrationID: "google",
    resolveSettings: resolveGeminiSettings,
    create: createGeminiImageProvider,
  },
}

/** The registered provider ids. */
export function providerIds(): string[] {
  return Object.keys(PROVIDERS)
}

/** Look up a provider definition, or fail with the known ids. */
export function getProvider(id: string): ImageProviderDefinition {
  const definition = PROVIDERS[id]
  if (definition === undefined) {
    throw invalidArgument(
      `Unknown provider \`${id}\`. Known providers: ${providerIds().join(", ")}.`,
    )
  }
  return definition
}
