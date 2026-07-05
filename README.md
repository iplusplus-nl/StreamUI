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
STREAMUI_RETRIEVAL=true
STREAMUI_TOOL_MAX_STEPS=4
STREAMUI_SEARCH_PROVIDER=auto
```

The default model is `google/gemini-3.1-pro-preview` when `OPENROUTER_MODEL` is not set. Reasoning effort defaults to `low` to keep the reasoning disclosure responsive. StreamUI gives the final generation model a native `retrieve` tool through Vercel AI SDK; the model can call it for URLs, online resources, images, or current information before continuing the same response. The backend loads `.env` from the repo root and can also read an overriding `apps/web/.env`.

## Run

```bash
npm run dev
```

The root script delegates to `@streamui/web`. The Vite app runs at `http://127.0.0.1:5173`, and the Express proxy runs at `http://127.0.0.1:8787`.

The browser calls the local backend at `POST /api/chat`; the backend reads `OPENROUTER_API_KEY` from `.env` and forwards the request through Vercel AI SDK. The API key is never sent to the browser. The backend streams newline-delimited JSON events with separate `reasoning` and `content` chunks.

## Session Storage

Chat sessions are stored as one shared global state in SQLite. By default the backend writes to `sessions/state.sqlite`. Existing `sessions/state.json` data is migrated into SQLite the first time the database is empty.

For production, set `STREAMUI_SESSION_DB` to a path on a persistent disk or volume, for example:

```bash
STREAMUI_SESSION_DB=/data/streamui/state.sqlite
```

If the SQLite file lives in an ephemeral deploy directory, sessions will still disappear after an instance restart or redeploy.

You can also run workspace scripts directly:

```bash
npm --workspace @streamui/web run dev
npm --workspace @streamui/web run build
```

## Retrieval and External Resources

StreamUI exposes a native `retrieve` tool to the model in the main `streamText` call. The AI SDK step loop handles tool calls and tool results, so there is no separate planner pass or custom orchestration loop. The retrieval tool can:

- Search the web through Brave, Tavily, Serper, or a DuckDuckGo HTML fallback.
- Search dedicated visual sources for image/gallery prompts, including Openverse, Wikimedia-oriented web results, NASA, Library of Congress, The Met, Art Institute of Chicago, and optional Pexels, Unsplash, and Rijksmuseum integrations.
- Fetch requested URLs with Node `fetch`, or optional Playwright when `STREAMUI_BROWSER_ENGINE=playwright` and Playwright is installed.
- Parse HTML into structured page excerpts, links, source metadata, and image candidates.
- Return those sources to the same model generation while keeping the current streaming HTML protocol. The HTML artifact is still assistant content, not a tool result.

The model decides whether to call `retrieve`; `STREAMUI_TOOL_MAX_STEPS` controls the maximum AI SDK step count for tool use and final generation. Tool progress streams into the reasoning panel, and user-facing HTML still streams as normal assistant content. You can also call `POST /api/retrieve` directly for debugging.

The chat input also supports local image attachments. Images are converted to data URLs in the browser, lightly resized when needed, and sent to Vercel AI SDK as multimodal `image` message parts. Use a vision-capable model for image analysis, OCR, comparison, or image-informed visual responses.

Useful `.env` controls:

```bash
STREAMUI_RETRIEVAL=true
STREAMUI_TOOL_MAX_STEPS=4
STREAMUI_SEARCH_PROVIDER=auto
STREAMUI_SEARCH_MAX_RESULTS=5
STREAMUI_SEARCH_ALLOW_DUCKDUCKGO=true
STREAMUI_RETRIEVAL_MAX_PAGES=4
STREAMUI_PAGE_MAX_CHARS=10000
STREAMUI_RETRIEVAL_CONTEXT_MAX_CHARS=32000
STREAMUI_RETRIEVAL_TIMEOUT_MS=12000
STREAMUI_BROWSER_ENGINE=fetch
STREAMUI_RETRIEVAL_ALLOWED_DOMAINS=
STREAMUI_RETRIEVAL_BLOCKED_DOMAINS=
STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS=false
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
SERPER_API_KEY=
PEXELS_API_KEY=
UNSPLASH_ACCESS_KEY=
RIJKSMUSEUM_API_KEY=
```

The sandboxed artifact can use HTTPS images, media, iframes, stylesheets, scripts, and CORS-friendly runtime requests. The preview iframe includes `allow-same-origin` so browser extensions that expect a page origin can run without noisy `null`-origin sandbox errors. The renderer still flags browser storage, cookies, parent/top/opener access, permissions APIs, and `document.write`.

## Runtime Protocol

For visual, interactive, frontend, educational, or UI-like prompts, the system prompt asks the model to stream:

```html
<sessiontitle>Concise hidden history title</sessiontitle>
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

- `<sessiontitle>` is hidden from the artifact and saved as the history sidebar title.
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
- A lightweight Raw stream disclosure keeps the original model output available for debugging.

If no valid `<streamui>` block appears, the assistant response stays as a normal assistant message.

## Important Files

- `apps/web/server/openrouter.ts` uses Vercel AI SDK `streamText` with native tools and streams OpenRouter responses back to the frontend as NDJSON `reasoning` and `content` chunks.
- `apps/web/server/retrievalTool.ts` wraps the retrieval service as an AI SDK `retrieve` tool and records tool telemetry for logs.
- `apps/web/server/retrieval.ts` owns search providers, URL fetching, optional Playwright browsing, HTML parsing, image/link extraction, and structured retrieval context.
- `apps/web/server/index.ts` runs the local Express proxy and loads repo-root `.env`.
- `apps/web/src/server/systemPrompt.ts` defines the model behavior and output protocol.
- `apps/web/src/App.tsx` wires assistant-ui's external-store runtime to the StreamUI request/render pipeline.
- `apps/web/src/components/ChatInput.tsx` contains the assistant-ui composer and attachment controls.
- `apps/web/src/core/assistantAttachments.ts` adapts local image uploads into assistant-ui attachments and model image parts.
- `apps/web/src/core/createStreamingRenderer.ts` owns the renderer lifecycle.
- `apps/web/src/core/completePartialHtml.ts` performs speculative HTML completion.
- `apps/web/src/core/buildIframeDocument.ts` builds the sandboxed iframe document.
- `apps/web/src/core/extractStreamUiParts.ts` parses `<sessiontitle>`, `<chat>`, and `<streamui>` from the assistant stream.
