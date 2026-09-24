import type { GenerationSettings } from "./config.ts"

/** A local reference image passed to the edits endpoint. */
export interface ImageReference {
  filename: string
  mimeType: string
  data: Uint8Array
}

export interface ImageRequest {
  prompt: string
  settings: GenerationSettings
  references?: ImageReference[]
}

export interface ImageResult {
  data: Uint8Array
  mimeType: string
  revisedPrompt?: string
}

/** Options a provider factory receives when the tool builds an adapter. */
export interface ImageProviderOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

/**
 * The internal seam between the tool and an image service.
 *
 * It stays private to the package: the tool picks an implementation through the
 * internal registry in `providers.ts`. Adding a service means adding an
 * implementation there, not exposing a public plugin API.
 */
export interface ImageProvider {
  generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>
}
