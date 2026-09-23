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

/**
 * The internal seam between the tool and an image service.
 *
 * It stays private to the package: the tool depends on this interface, and the
 * OpenAI adapter implements it. A second service would be added by writing
 * another implementation, not by exposing a plugin registry.
 */
export interface ImageProvider {
  generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>
}
