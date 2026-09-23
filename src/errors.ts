/**
 * Error raised by the `gpt_imagegen` tool and its internal image provider.
 *
 * Every error names the operation that failed and carries a stable `code` so
 * callers and tests can branch on the failure without matching message text.
 * Messages never include the API key or other request credentials.
 */
export type ImageToolErrorCode =
  | "missing_api_key"
  | "invalid_argument"
  | "invalid_reference"
  | "api_error"
  | "malformed_response"
  | "cancelled"
  | "write_failed"

/** The operations the tool and provider report failures against. */
export type ImageToolOperation =
  | "validate API key"
  | "validate arguments"
  | "read reference image"
  | "generate image"
  | "edit image"
  | "decode image response"
  | "write image file"

export class ImageToolError extends Error {
  readonly code: ImageToolErrorCode
  readonly operation: ImageToolOperation

  constructor(
    code: ImageToolErrorCode,
    operation: ImageToolOperation,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "ImageToolError"
    this.code = code
    this.operation = operation
  }
}

/** An invalid-argument error with the shared validation operation. */
export function invalidArgument(message: string): ImageToolError {
  return new ImageToolError("invalid_argument", "validate arguments", message)
}

/** Return `value` when it is a non-empty string, otherwise fail validation. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidArgument(`\`${field}\` must be a non-empty string.`)
  }
  return value
}
