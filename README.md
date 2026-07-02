# StreamUI Runtime Demo

This is a local demo for the StreamUI Runtime method: streaming, sandboxed rendering of LLM-generated frontend code. It is not positioned as a ChatGPT clone or an AI app builder. The ChatGPT-style shell exists so a normal message can turn into a progressively rendered UI artifact.

The repo is now organized as an npm workspace. The first app lives in `apps/web`; future native, desktop, or service surfaces can be added under `apps/*` without crowding the web runtime.

## Stack

- npm workspaces
- Vite + React + TypeScript in `apps/web`
- assistant-ui runtime and primitives for the chat thread/composer shell
- Node/Express backend proxy
- Vercel AI SDK `streamText`
- `@openrouter/ai-sdk-provider` for OpenRouter models

## Setup

```bash
npm install
cp .env.example .env
```

Add your OpenRouter key to `.env`:

```bash
OPENROUTER_API_KEY=your_openrouter_key_here
OPENROUTER_MODEL=google/gemini-3.1-pro-preview
OPENROUTER_REASONING_EFFORT=low
OPENROUTER_WEB_TOOLS=true
OPENROUTER_DATETIME_TOOL=true
```

The default model is `google/gemini-3.1-pro-preview` when `OPENROUTER_MODEL` is not set. Reasoning effort defaults to `low` to keep the reasoning disclosure responsive. OpenRouter server-side web search, web fetch, and datetime tools are still enabled by default through provider extra body options. The backend loads `.env` from the repo root and can also read an overriding `apps/web/.env`.

## Run

```bash
npm run dev
```

The root script delegates to `@streamui/web`. The Vite app runs at `http://127.0.0.1:5173`, and the Express proxy runs at `http://127.0.0.1:8787`.

The browser calls the local backend at `POST /api/chat`; the backend reads `OPENROUTER_API_KEY` from `.env` and forwards the request through Vercel AI SDK. The API key is never sent to the browser. The backend streams newline-delimited JSON events with separate `reasoning` and `content` chunks.

You can also run workspace scripts directly:

```bash
npm --workspace @streamui/web run dev
npm --workspace @streamui/web run build
```

## Web Tools and External Resources

Each chat request includes OpenRouter server tools by default:

- `openrouter:web_search` for current web search.
- `openrouter:web_fetch` for reading a URL or PDF that the user asks about.
- `openrouter:datetime` for current date/time grounding.

The model decides when to call these tools. OpenRouter executes them server-side, so StreamUI keeps the existing streaming HTML protocol instead of implementing a separate client-side agent loop.

The chat input also supports local image attachments. Images are converted to data URLs in the browser, lightly resized when needed, and sent to Vercel AI SDK as multimodal `image` message parts. Use a vision-capable model for image analysis, OCR, comparison, or image-informed visual responses.

Useful `.env` controls:

```bash
OPENROUTER_WEB_TOOLS=true
OPENROUTER_DATETIME_TOOL=true
OPENROUTER_WEB_SEARCH_ENGINE=auto
OPENROUTER_WEB_SEARCH_MAX_RESULTS=5
OPENROUTER_WEB_SEARCH_MAX_TOTAL_RESULTS=12
OPENROUTER_WEB_SEARCH_CONTEXT_SIZE=medium
OPENROUTER_WEB_FETCH_ENGINE=auto
OPENROUTER_WEB_FETCH_MAX_USES=6
OPENROUTER_WEB_FETCH_MAX_CONTENT_TOKENS=50000
OPENROUTER_WEB_ALLOWED_DOMAINS=
OPENROUTER_WEB_BLOCKED_DOMAINS=
```

The sandboxed artifact can use HTTPS images, media, iframes, stylesheets, scripts, and CORS-friendly runtime requests. The preview iframe includes `allow-same-origin` so browser extensions that expect a page origin can run without noisy `null`-origin sandbox errors. The renderer still flags browser storage, cookies, parent/top/opener access, permissions APIs, and `document.write`.

## Runtime Protocol

For visual, interactive, frontend, educational, or UI-like prompts, the system prompt asks the model to stream:

```html
<chat></chat>

<streamui>
<!-- all user-facing language and visual response lives here -->
<section class="streamui-response">
  <div class="streamui-chat">
    <p>Default natural replies use the built-in assistant prose classes.</p>
  </div>
</section>
<script>
  // optional small vanilla JavaScript
</script>
</streamui>
```

The frontend parses the stream as it arrives:

- `<chat>` is intentionally empty for visual responses; the HTML artifact is the assistant's primary expression.
- `<streamui>` is fed chunk by chunk into `createStreamingRenderer`.
- Reasoning events render in an assistant-ui-style reasoning disclosure while the assistant is working, then auto-collapse when generation finishes.
- Partial HTML is speculatively completed for live preview updates.
- The iframe preloads default chat-response classes: `streamui-response`, `streamui-chat`, `streamui-muted`, `streamui-actions`, and `streamui-button`.
- Models are prompted to use the default transparent assistant prose classes for ordinary replies, and only add small custom style islands when a visual or interaction needs them.
- Models are prompted to avoid generic rounded-card grids, dashboards, pricing panels, and SaaS layouts unless the user explicitly asks for them, and to pursue more art-directed visual compositions for visual prompts.
- User-facing language should be placed inside the HTML artifact as typography, labels, captions, or annotations.
- Script blocks are ignored while streaming and only allowed once the artifact is complete.
- The artifact renders inside `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`.
- The iframe CSP allows HTTPS external resources and runtime requests, while keeping objects, forms, and base URLs disabled.
- Completed artifacts can be downloaded as a full-height PNG from the artifact toolbar.
- A lightweight Raw stream disclosure keeps the original model output available for debugging.

If no valid `<streamui>` block appears, the assistant response stays as a normal assistant message.

## Important Files

- `apps/web/server/openrouter.ts` uses Vercel AI SDK to stream OpenRouter responses back to the frontend as NDJSON `reasoning` and `content` chunks.
- `apps/web/server/index.ts` runs the local Express proxy and loads repo-root `.env`.
- `apps/web/src/server/systemPrompt.ts` defines the model behavior and output protocol.
- `apps/web/src/App.tsx` wires assistant-ui's external-store runtime to the StreamUI request/render pipeline.
- `apps/web/src/components/ChatInput.tsx` contains the assistant-ui composer and attachment controls.
- `apps/web/src/core/assistantAttachments.ts` adapts local image uploads into assistant-ui attachments and model image parts.
- `apps/web/src/core/createStreamingRenderer.ts` owns the renderer lifecycle.
- `apps/web/src/core/completePartialHtml.ts` performs speculative HTML completion.
- `apps/web/src/core/buildIframeDocument.ts` builds the sandboxed iframe document.
- `apps/web/src/core/extractStreamUiParts.ts` parses `<chat>` and `<streamui>` from the assistant stream.
