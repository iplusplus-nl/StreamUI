# StreamUI Runtime Demo

This is a local demo for the StreamUI Runtime method: streaming, sandboxed rendering of LLM-generated frontend code. It is not positioned as a ChatGPT clone or an AI app builder. The ChatGPT-style shell exists so a normal message can turn into a progressively rendered UI artifact.

## Stack

- Vite
- React
- TypeScript
- Node/Express backend proxy
- OpenRouter Chat Completions API with streaming enabled

## Setup

```bash
npm install
cp .env.example .env
```

Add your OpenRouter key to `.env`:

```bash
OPENROUTER_API_KEY=your_openrouter_key_here
OPENROUTER_MODEL=z-ai/glm-5.2
OPENROUTER_REASONING_EFFORT=low
```

The default model is `z-ai/glm-5.2` when `OPENROUTER_MODEL` is not set. Reasoning effort defaults to `low` to keep the thinking panel responsive.

## Run

```bash
npm run dev
```

The Vite app runs at `http://127.0.0.1:5173`. The browser calls the local backend at `POST /api/chat`; the backend reads `OPENROUTER_API_KEY` from `.env` and forwards the request to OpenRouter. The API key is never sent to the browser. The backend streams newline-delimited JSON events with separate `reasoning` and `content` chunks.

## Runtime Protocol

For visual, interactive, frontend, educational, or UI-like prompts, the system prompt asks the model to stream:

```html
<chat>
A short natural-language response.
</chat>

<streamui>
<style>
  /* short scoped CSS for the next visible section */
</style>
<section>
  <!-- matching visible HTML -->
</section>
<style>
  /* another short style island */
</style>
<div>
  <!-- next visible control or section -->
</div>
<script>
  // optional small vanilla JavaScript
</script>
</streamui>
```

The frontend parses the stream as it arrives:

- `<chat>` becomes the normal assistant text bubble.
- `<streamui>` is fed chunk by chunk into `createStreamingRenderer`.
- Reasoning events render in a thinking panel while the assistant is working, then auto-collapse when generation finishes.
- Partial HTML is speculatively completed for live preview updates.
- Models are prompted to use small style islands followed immediately by matching visible controls, so the canvas can grow downward while streaming.
- Script blocks are ignored while streaming and only allowed once the artifact is complete.
- The artifact renders inside `sandbox="allow-scripts"` without `allow-same-origin`.
- A collapsible Raw stream panel keeps the original model output available for debugging.

If no valid `<streamui>` block appears, the assistant response stays as a normal chat bubble.

## Important Files

- `server/openrouter.ts` streams OpenRouter responses back to the frontend as NDJSON `reasoning` and `content` chunks.
- `src/server/systemPrompt.ts` defines the model behavior and output protocol.
- `src/core/createStreamingRenderer.ts` owns the renderer lifecycle.
- `src/core/completePartialHtml.ts` performs speculative HTML completion.
- `src/core/buildIframeDocument.ts` builds the sandboxed iframe document.
- `src/core/extractStreamUiParts.ts` parses `<chat>` and `<streamui>` from the assistant stream.
