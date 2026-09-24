import { DEFAULT_MODEL } from "./config.ts"
import { invalidArgument } from "./errors.ts"
import { createOpenAIImageProvider } from "./openai-provider.ts"
import type { ImageProvider, ImageProviderOptions } from "./provider.ts"

/** The provider used when the caller does not name one. */
export const DEFAULT_PROVIDER = "openai"

export interface ImageProviderDefinition {
  /** The id used in the tool's `provider` input. */
  readonly id: string
  /** The model used when the caller does not name one. */
  readonly defaultModel: string
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
    create: createOpenAIImageProvider,
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
