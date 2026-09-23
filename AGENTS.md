# opencode-img

## Project

`opencode-img` is an OpenCode V2 plugin for generating and editing bitmap images through the OpenAI Image API. It exposes a `gpt_imagegen` tool, supports prompt-based generation and local reference images, and saves one output without overwriting an existing file. The OpenAI API key comes from `OPENAI_API_KEY` or the OpenAI connection the user made with `/connect`. The provider boundary stays internal so another image service can be added later.

## Stack

- TypeScript (development on Node 24; OpenCode runs the plugin in its bundled Bun runtime)
- ESM package managed with pnpm
- OpenCode V2 plugin API through `@opencode/plugin`
- Native `fetch`, `FormData`, and `Blob`; no OpenAI SDK
- No test framework dependency; use the Node test tooling available to the package

## Surfaces and flow

The `gpt_imagegen` tool accepts a prompt, output path, optional model, quality, size, output format, and reference-image paths. It validates the request, selects the generation or multipart edit endpoint, decodes the returned image, chooses a non-conflicting output path, writes the file, and returns its path and metadata.

The first release uses OpenAI only. The internal provider seam should not become a public plugin registry.

## Commands

- `pnpm install` — install dependencies
- `pnpm test` — run the complete test suite
- `pnpm typecheck` — run TypeScript checks
- `pnpm build` — build the ESM package
