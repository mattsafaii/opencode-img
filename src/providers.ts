import type { GenerationSettings, GenerationSettingsInput } from "./config.ts"
import { ImageToolError, invalidArgument } from "./errors.ts"
import {
  createGeminiImageProvider,
  resolveGeminiSettings,
} from "./gemini-provider.ts"
import {
  createOpenAIImageProvider,
  resolveOpenAISettings,
} from "./openai-provider.ts"
import type { ImageProvider, ImageProviderOptions } from "./provider.ts"

/** The provider used when the caller does not name one. */
export const DEFAULT_PROVIDER = "openai"

export interface ImageProviderDefinition {
  /** The id used in the tool's `provider` input. */
  readonly id: string
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

/** A registry entry, without the id it is keyed by. */
type ImageProviderSpec = Omit<ImageProviderDefinition, "id">

/**
 * The internal provider registry.
 *
 * It stays private to the package. The tool routes to an entry here, and adding
 * a service means adding an entry, not exposing a public plugin API.
 */
const PROVIDERS: Readonly<Record<string, ImageProviderSpec>> = {
  openai: {
    envVars: ["OPENAI_API_KEY"],
    integrationID: "openai",
    resolveSettings: resolveOpenAISettings,
    create: createOpenAIImageProvider,
  },
  gemini: {
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
  const spec = PROVIDERS[id]
  if (spec === undefined) {
    throw invalidArgument(
      `Unknown provider \`${id}\`. Known providers: ${providerIds().join(", ")}.`,
    )
  }
  return { id, ...spec }
}

export interface ApiKeySources {
  /** Environment variables the key can come from. */
  env: Record<string, string | undefined>
  /** Resolve a key from an OpenCode integration connection. */
  connectionKey?: (integrationID: string) => Promise<string | undefined>
}

/**
 * Find a provider's API key: its environment variables first, then its OpenCode
 * integration connection. Fails before any network request when none is present.
 */
export async function resolveProviderKey(
  definition: ImageProviderDefinition,
  sources: ApiKeySources,
): Promise<string> {
  for (const name of definition.envVars) {
    const value = sources.env[name]
    if (typeof value === "string" && value !== "") return value
  }

  const fromConnection = await sources.connectionKey?.(definition.integrationID)
  if (typeof fromConnection === "string" && fromConnection !== "") return fromConnection

  throw new ImageToolError(
    "missing_api_key",
    "validate API key",
    `No ${definition.id} API key was found. Set ${definition.envVars.join(" or ")}, or connect the ${definition.integrationID} integration in OpenCode (run /connect).`,
  )
}
