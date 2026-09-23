import { constants } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { ImageToolError } from "./errors.ts"

/**
 * Resolve a requested output path against the OpenCode session directory.
 * Absolute paths are returned unchanged.
 */
export function resolveOutputPath(requested: string, sessionDirectory: string): string {
  return isAbsolute(requested) ? requested : resolve(sessionDirectory, requested)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function versionedPath(filePath: string, version: number): string {
  const extension = extname(filePath)
  const base = extension === "" ? filePath : filePath.slice(0, -extension.length)
  return `${base}-${version}${extension}`
}

/**
 * Return the first path at or after `filePath` that does not yet exist.
 * `report.png` becomes `report-1.png`, then `report-2.png`, and so on.
 */
export async function chooseAvailablePath(filePath: string): Promise<string> {
  if (!(await exists(filePath))) return filePath
  for (let version = 1; ; version += 1) {
    const candidate = versionedPath(filePath, version)
    if (!(await exists(candidate))) return candidate
  }
}

/**
 * Write the image at the first available path without replacing an existing
 * file. Uses the exclusive-create flag so a concurrent writer cannot be
 * overwritten; a collision advances to the next versioned name.
 */
export async function writeImageWithoutOverwrite(
  targetPath: string,
  data: Uint8Array,
): Promise<string> {
  let candidate = await chooseAvailablePath(targetPath)
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      await mkdir(dirname(candidate), { recursive: true })
      await writeFile(candidate, data, { flag: "wx" })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        candidate = await chooseAvailablePath(candidate)
        continue
      }
      throw new ImageToolError(
        "write_failed",
        "write image file",
        `Could not write the image to \`${candidate}\`: ${(error as Error).message}.`,
        { cause: error },
      )
    }
  }
  throw new ImageToolError(
    "write_failed",
    "write image file",
    `Could not find an available filename for \`${targetPath}\`.`,
  )
}
