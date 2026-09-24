import { ImageToolError } from "./errors.ts"
import type { OutputFormat } from "./config.ts"

export interface DecodedImage {
  data: Uint8Array
  revisedPrompt?: string
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function malformed(detail: string): ImageToolError {
  return new ImageToolError(
    "malformed_response",
    "decode image response",
    `The image response could not be read: ${detail}.`,
  )
}

/**
 * Decode a base64 image payload, rejecting empty or invalid data so a
 * zero-byte or corrupt image never reaches the filesystem.
 */
export function decodeBase64Image(encoded: unknown): Uint8Array {
  if (typeof encoded !== "string" || encoded === "") {
    throw malformed("the image entry had no base64 payload")
  }
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw malformed("the base64 payload was not valid base64")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength === 0) {
    throw malformed("the decoded image was empty")
  }
  return bytes
}

/**
 * Pull the first image out of an OpenAI Images response.
 *
 * GPT image models and DALL·E models configured with `response_format=b64_json`
 * both return `data[0].b64_json`.
 */
export function decodeImageResponse(payload: unknown): DecodedImage {
  if (typeof payload !== "object" || payload === null) {
    throw malformed("the response body was not a JSON object")
  }

  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw malformed("the response contained no images")
  }

  const first = data[0] as { b64_json?: unknown; revised_prompt?: unknown }
  const decoded: DecodedImage = { data: decodeBase64Image(first?.b64_json) }
  if (typeof first.revised_prompt === "string" && first.revised_prompt !== "") {
    decoded.revisedPrompt = first.revised_prompt
  }
  return decoded
}

/** The MIME type OpenAI returns for a given output format. */
export function mimeTypeForOutputFormat(format: OutputFormat | undefined): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "png":
    case undefined:
      return "image/png"
  }
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

/** The MIME type of a reference image, or `undefined` for an unsupported type. */
export function mimeTypeForReferencePath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return undefined
  return MIME_BY_EXTENSION[filePath.slice(dot).toLowerCase()]
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * The MIME type implied by an image's magic bytes, for adapters that cannot
 * name the output format up front. Defaults to PNG.
 */
export function mimeTypeForImageBytes(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp"
  }
  return "image/png"
}

/** The extensions the edits endpoint accepts for reference images. */
export const SUPPORTED_REFERENCE_EXTENSIONS = Object.keys(MIME_BY_EXTENSION)
