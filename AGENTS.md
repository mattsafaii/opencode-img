# opencode-img

## Project

`opencode-img` is an OpenCode V2 plugin for generating and editing bitmap images through a provider's image API. It exposes a `gpt_imagegen` tool, supports prompt-based generation and local reference images, and saves one output without overwriting an existing file. Each provider's API key comes from its environment variable or the OpenCode integration connection the user made with `/connect`. Providers register internally so another image service can be added without a public plugin registry.

## Stack

- TypeScript (development on Node 24; OpenCode runs the plugin in its bundled Bun runtime)
- ESM package managed with pnpm
- OpenCode V2 plugin API through `@opencode/plugin`
- Native `fetch`, `FormData`, and `Blob`; no OpenAI SDK
- No test framework dependency; use the Node test tooling available to the package

## Surfaces and flow

The `gpt_imagegen` tool accepts a prompt, output path, an optional provider, model, quality, size, output format, and reference-image paths. It validates the request, routes to the selected provider, decodes the returned image, chooses a non-conflicting output path, writes the file, and returns its path and metadata.

Providers register in an internal registry (`openai`, `gemini`). The registry stays private; adding a service means adding an entry, not a public plugin API.

## Commands

- `pnpm install` — install dependencies
- `pnpm test` — run the complete test suite
- `pnpm typecheck` — run TypeScript checks
- `pnpm build` — build the ESM package
