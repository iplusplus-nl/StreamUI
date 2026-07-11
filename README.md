# ChatHTML Runtime Demo

This is a local demo for the ChatHTML Runtime method: streaming, sandboxed rendering of LLM-generated frontend code. It is not positioned as a ChatGPT clone or an AI app builder. The ChatGPT-style shell exists so a normal message can turn into a progressively rendered UI artifact.

The repo is now organized as an npm workspace. The first app lives in `apps/web`; future native, desktop, or service surfaces can be added under `apps/*` without crowding the web runtime.

## Stack

- npm workspaces
- Vite + React + TypeScript in `apps/web`
- assistant-ui runtime and primitives for the chat thread/composer shell
- Node/Express backend proxy
- OpenRouter Responses API streaming with native function tools

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
STREAMUI_SEARCH_PROVIDER=auto
```

The default model is `google/gemini-3.1-pro-preview` when `OPENROUTER_MODEL` is not set. Reasoning effort defaults to `low` to keep the reasoning disclosure responsive. ChatHTML calls OpenRouter's Responses API directly and gives the model native tools for retrieval, session files, and memory updates before continuing the same response. The backend loads `.env` from the repo root and can also read an overriding `apps/web/.env`.

## Run

```bash
npm run dev
```

The root script delegates to `@chathtml/web`. The Vite app runs at `http://127.0.0.1:5173`, and the Express proxy runs at `http://127.0.0.1:8787`.

The browser calls the local backend at `POST /api/chat`; the backend reads `OPENROUTER_API_KEY` from `.env` and forwards the request to OpenRouter's `/responses` endpoint. The API key is never sent to the browser. The backend streams newline-delimited JSON events with separate `reasoning`, `content`, and memory-update chunks.

## HTML Hosting

HTML artifact hosting is provided by the standalone
[`aietheia/oops`](https://github.com/aietheia/oops) service. ChatHTML posts share
requests to `POST /api/html-shares`; production deployments should route that
path, plus `/artifacts/*`, to the Oops service.

## Open Source and Hosted Cloud

This repository is the single public source tree for ChatHTML. The current
product deployment is open: no account gate, no billing gate, and one shared
conversation history while the product is still early.

The optional hosted backend can report `cloud.enabled: true` from
`GET /api/settings` to expose account, billing, and managed-provider surfaces.
Authentication uses a Service-hosted OAuth flow: ChatHTML redirects the browser
to the Service for email registration or login, then its backend exchanges a
one-time PKCE-protected code and keeps the service session in an HttpOnly cookie.
The Service URL is server configuration and is not exposed as a frontend
setting. See `docs/cloud-api.md` for the HTTP contract.

## Session Storage

Chat sessions are stored persistently in SQLite as one shared early-product state, so every browser connected to the same deployment can see the same chat history. The client periodically syncs from the backend while the page is open, and session saves are merged so an older tab is less likely to overwrite chats created elsewhere.

By default the backend writes to `sessions/state.sqlite`. Existing `sessions/state.json` data is migrated into SQLite the first time the shared state is empty.

For production, set `STREAMUI_SESSION_DB` to a path on a persistent disk or volume, for example:

```bash
STREAMUI_SESSION_DB=/data/chathtml/state.sqlite
```

If the SQLite file lives in an ephemeral deploy directory, sessions will still disappear after an instance restart or redeploy. This shared-history mode is intended for testing; hosted multi-user deployments should provide authenticated session storage from their backend.

You can also run workspace scripts directly:

```bash
npm --workspace @chathtml/web run dev
npm --workspace @chathtml/web run build
```

## Bug Reports and GitHub Issues

The in-app bug report dialog posts to `POST /api/bug-reports`. The backend stores
each report under `sessions/bug-reports/YYYY-MM-DD/<report-id>/` with
`report.json`, any attached images, and a `github.json` sync record when GitHub
issue sync is configured.

When `GITHUB_REPOSITORY` and `GITHUB_ISSUES_TOKEN` are set, each submitted bug
report creates a GitHub issue. Attached images are not uploaded to GitHub and
are not embedded as Markdown images. The issue shows random-letter links that
point to the local ChatHTML server, so only automation running on the same
server can fetch the image bytes. Use a private issue repo if report text may
contain sensitive data.

Useful `.env` controls:

```bash
GITHUB_REPOSITORY=aietheia/ChatHTML
GITHUB_ISSUES_TOKEN=
GITHUB_ISSUE_LABELS=bug,user-report
GITHUB_ISSUE_ASSIGNEES=
CHATHTML_BUG_REPORT_ISSUE_BASE_URL=http://127.0.0.1:8787
CHATHTML_BUG_REPORT_IMAGE_ALLOW_PUBLIC=false
CHATHTML_BUG_REPORT_DIR=
```

Use a token with only the repository permissions needed to create issues and
apply labels.

## Retrieval and External Resources

ChatHTML exposes a native `retrieve` tool to the model in the main Responses API call. The Responses function-call loop handles tool calls and tool results, so there is no separate planner pass or keyword router. The retrieval tool can:

- Search the web through Brave, Tavily, Serper, or a DuckDuckGo HTML fallback.
- Search dedicated visual sources for image/gallery prompts, including Openverse, Wikimedia-oriented web results, NASA, Library of Congress, The Met, Art Institute of Chicago, and optional Pexels, Unsplash, and Rijksmuseum integrations.
- Fetch requested URLs with Node `fetch`, or optional Playwright when `STREAMUI_BROWSER_ENGINE=playwright` and Playwright is installed.
- Parse HTML into structured page excerpts, links, source metadata, and image candidates.
- Return those sources to the same model generation while keeping the current streaming HTML protocol. The HTML artifact is still assistant content, not a tool result.

The model decides whether to call `retrieve`; by default native tool calling continues until the model stops requesting tools and produces a final answer. `STREAMUI_TOOL_MAX_STEPS` is optional and only acts as a safety cap when explicitly set to a positive integer. Tool progress streams into the reasoning panel, and user-facing HTML still streams as normal assistant content. You can also call `POST /api/retrieve` directly for debugging.

The chat input also supports local image attachments. Images are converted to data URLs in the browser, lightly resized when needed, uploaded to `POST /api/sessions/:sessionId/files` as draft files while they sit in the composer, and committed to the active session file list only when the user sends the message. Local development writes file bytes under `sessions/files`; production can replace that layer with S3, R2, MinIO, or another object store.

Session files have stable ids and capability URLs. Draft files can be previewed through their capability URL but are hidden from `GET /api/sessions`, `GET /api/sessions/:sessionId/files`, and model file tools until sent. The model can use `listFiles` and `readFile` to inspect committed session files; image reads return JSON metadata as the tool result and then attach the image bytes as a follow-up multimodal input message for models that support vision. If the model wants to render a user-uploaded image inside the generated artifact, it should copy the file's `embedUrl` exactly into HTML, such as `<img src="...">`. Assistant ChatHTML artifacts are also saved into the session file list as raw source files so later turns can read exact prior artifact code.

File API endpoints:

```txt
GET    /api/sessions/:sessionId/files
POST   /api/sessions/:sessionId/files
GET    /api/files/:fileId/content?token=...
DELETE /api/sessions/:sessionId/files/:fileId
```

Useful `.env` controls:

```bash
STREAMUI_RETRIEVAL=true
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

The wire protocol still uses the legacy `<streamui>` tag and `streamui-*` class/capability names for compatibility with existing sessions and renderer code.

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

- `apps/web/server/openrouter.ts` uses OpenRouter Responses API streaming with native tools and streams responses back to the frontend as NDJSON `reasoning`, `content`, and memory events.
- `apps/web/server/fileStore.ts` stores file bytes behind stable session file metadata and content URLs.
- `apps/web/server/sessionFileTools.ts` defines session file listing/reading tools, including image metadata and follow-up multimodal image input.
- `apps/web/server/retrievalTool.ts` wraps the retrieval service as a reusable `retrieve` tool executor and records tool telemetry for logs.
- `apps/web/server/retrieval.ts` owns search providers, URL fetching, optional Playwright browsing, HTML parsing, image/link extraction, and structured retrieval context.
- `apps/web/server/index.ts` runs the local Express proxy and loads repo-root `.env`.
- `apps/web/src/server/systemPrompt.ts` defines the model behavior and output protocol.
- `apps/web/src/App.tsx` wires assistant-ui's external-store runtime to the ChatHTML request/render pipeline.
- `apps/web/src/components/ChatInput.tsx` contains the assistant-ui composer and attachment controls.
- `apps/web/src/core/assistantAttachments.ts` adapts local image uploads into assistant-ui attachments and model image parts.
- `apps/web/src/core/createStreamingRenderer.ts` owns the renderer lifecycle.
- `apps/web/src/core/completePartialHtml.ts` performs speculative HTML completion.
- `apps/web/src/core/buildIframeDocument.ts` builds the sandboxed iframe document.
- `apps/web/src/core/extractStreamUiParts.ts` parses `<sessiontitle>`, `<chat>`, and `<streamui>` from the assistant stream.
