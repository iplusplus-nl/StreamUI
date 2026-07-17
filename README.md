# ChatHTML

[![CI](https://github.com/aietheia/ChatHTML/actions/workflows/ci.yml/badge.svg)](https://github.com/aietheia/ChatHTML/actions/workflows/ci.yml)

**Turn a prompt into a live, streaming HTML response.**

ChatHTML is an open-source runtime for model-generated interfaces. Instead of
placing code in a fenced block or waiting for a complete page, it streams HTML
into the conversation and progressively renders it as the model writes. The
result can be explanatory, visual, interactive, or simply a well-typeset answer.

ChatHTML is focused on the response medium: it is not a ChatGPT clone and it is
not an app-builder workflow. The chat shell exists so a normal message can
become a sandboxed UI artifact.

## Why ChatHTML?

- **See the response take shape.** Partial markup is speculatively completed so
  the artifact remains visible while tokens arrive.
- **Interact with the answer.** Completed artifacts can use forms, controls,
  small vanilla scripts, and buttons that continue the conversation.
- **Keep generated code contained.** Artifacts run in a sandboxed iframe with a
  restrictive CSP and runtime guards around sensitive browser APIs.
- **Give the model useful context.** Native tools can retrieve web resources,
  inspect session files, read images, and update long-term memory.
- **Iterate instead of starting over.** Select a rendered region, request an
  edit, regenerate a branch, or repair an artifact from a screenshot.
- **Take the result with you.** Copy the code or text, or export HTML, PNG, SVG,
  and diagnostics.

## Quick start

### Requirements

- Node.js 22.13 or newer
- npm
- An [OpenRouter](https://openrouter.ai/) API key

### 1. Install

```bash
git clone https://github.com/aietheia/ChatHTML.git
cd ChatHTML
npm install
```

### 2. Configure

Copy `.env.example` to `.env`:

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

At minimum, set the server-side provider key:

```dotenv
OPENROUTER_API_KEY=your_openrouter_key_here
OPENROUTER_MODEL=google/gemini-3.1-pro-preview
OPENROUTER_REASONING_EFFORT=low
```

The backend loads the root `.env` and an optional overriding `apps/web/.env`.
Environment keys stay on the server and are never sent to the browser.

### 3. Run

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite client runs on port `5173`; its Express
API proxy runs on `http://127.0.0.1:8787`.

## Plain Markdown vs. ChatHTML

Each row starts from the same request; the response medium is different. The
left side is the raw response from the same configured model after sending the
user prompt directly to OpenRouter, rendered as a plain Markdown document with
no product chrome. No system instruction or response-format instruction is
sent. The right side is the actual output of this repository's `/api/chat`
pipeline, rendered by the ChatHTML runtime. The exact submitted prompts are
stored in [`scripts/readme-comparison-prompts.mjs`](scripts/readme-comparison-prompts.mjs).
No ChatGPT screenshots or third-party product UI are used. External gallery
photos come from Wikimedia Commons and are credited next to the example.

<table>
  <thead>
    <tr>
      <th width="50%">Plain Markdown</th>
      <th width="50%">ChatHTML</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td colspan="2"><strong>Prompt 1 · Run a Pomodoro clock</strong><br><br>Build a working Pomodoro clock set to 25:00. Include Start/Pause, Reset, skip, Focus/Short Break/Long Break modes, four session progress dots, and a compact task field. Use a bold analog-inspired countdown with subtle motion and keyboard hints. Keep it polished and focused; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-pomodoro-clock.png" alt="A Markdown-only response containing a complete Pomodoro clock implementation" width="420"><br><sub><a href="docs/markdown-examples/pomodoro-clock.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/pomodoro-clock.png" alt="A working Pomodoro clock rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov30jz-906f0f3b9b794a8f89">Live example</a> · <a href="docs/examples/pomodoro-clock.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 2 · Curate an image gallery</strong><br><br>Create a compact editorial gallery titled “Evolution / I–X” celebrating the Mitsubishi Lancer Evolution. Keep the complete 2-by-2 gallery, filters, captions, and credits visible within a single viewport. Use the four provided Wikimedia Commons images and load every image eagerly. Show model generation, year, photographer, and license on each card, with filters for III, VI, IX, and X and a click-to-expand lightbox. Do not imply endorsement; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-lancer-evolution-gallery.png" alt="A Markdown-only response containing a complete Lancer Evolution gallery implementation" width="420"><br><sub><a href="docs/markdown-examples/lancer-evolution-gallery.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/lancer-evolution-gallery.png" alt="An image-rich Lancer Evolution gallery rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov315c-e13cff5689b64dea8f">Live example</a> · <a href="docs/examples/lancer-evolution-gallery.chathtml.html">Generated source</a><br>Photos: <a href="https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_Evolution_III_(1995)_(53619429931).jpg">III · Charles · CC BY 2.0</a> · <a href="https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_Evolution_VI.jpg">VI · Motoring Weapon R · CC BY-SA 3.0</a> · <a href="https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_Evolution_IX_(31677018768).jpg">IX · FotoSleuth · CC BY 2.0</a> · <a href="https://commons.wikimedia.org/wiki/File:Mitsubishi_Lancer_EVO_X.jpg">X · IFCAR · Public domain</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 3 · Make it playable</strong><br><br>Build a playable 2048 mini-game with arrow-key and swipe controls, score and best counters, a new game button, and a clear visual hierarchy. The initial HTML itself must contain all 16 visible board cells and a plausible mid-game seed; JavaScript may take over for moves after load. Do not access browser storage; keep the best score only in memory for the current artifact. Keep it compact and polished; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-game-2048.png" alt="A Markdown-only response containing a complete 2048 implementation" width="420"><br><sub><a href="docs/markdown-examples/game-2048.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/game-2048.png" alt="A playable seeded 2048 game rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov31n7-0ca9eac4000c48e894">Live example</a> · <a href="docs/examples/game-2048.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 4 · Direct a visual</strong><br><br>Build an interactive typographic poster studio. Show a bold live poster preview with the editable headline “MOVE / WITH / INTENT”, controls for palette, type scale, grain, alignment, and a shuffle button. Use only CSS shapes and typography; no external assets. Make it editorial, expressive, and polished; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-poster-studio.png" alt="A Markdown-only response containing a complete poster studio implementation" width="420"><br><sub><a href="docs/markdown-examples/poster-studio.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/poster-studio.png" alt="An interactive typographic poster studio rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov322p-63251906e2cd4d5694">Live example</a> · <a href="docs/examples/poster-studio.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 5 · Explain it interactively</strong><br><br>Teach me how cubic Bezier curves work. Build an interactive playground with a large curve, adjustable control points, the formula, and three named easing presets. Keep it focused and polished; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-bezier-playground.png" alt="A Markdown-only explanation and implementation of cubic Bezier curves" width="420"><br><sub><a href="docs/markdown-examples/bezier-playground.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/bezier-playground.png" alt="An interactive cubic Bezier curve playground rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov6ua0-d171eec5e4d743cbb2">Live example</a> · <a href="docs/examples/bezier-playground.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 6 · Build a working utility</strong><br><br>Build a tip and split calculator for a EUR 186.50 dinner shared by 4 people. Include editable bill, tip, and party-size controls, update totals live, and show the calculation clearly. Keep it compact and polished; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-split-calculator.png" alt="A Markdown-only response containing a complete tip calculator implementation" width="420"><br><sub><a href="docs/markdown-examples/split-calculator.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/split-calculator.png" alt="An interactive tip and split calculator rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov6va9-6b7d9ed3d3144b62a6">Live example</a> · <a href="docs/examples/split-calculator.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 7 · Step through a process</strong><br><br>Explain what happens after I type https://example.com into a browser and press Enter. Make an annotated, animated-looking pipeline from DNS through TCP and TLS, HTTP, and rendering, with controls to step through each stage. No web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-request-pipeline.png" alt="A Markdown-only response containing a complete browser pipeline implementation" width="420"><br><sub><a href="docs/markdown-examples/request-pipeline.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/request-pipeline.png" alt="An interactive browser request pipeline rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov6vxo-67d6f80caa6a46d988">Live example</a> · <a href="docs/examples/request-pipeline.chathtml.html">Generated source</a></sub></td>
    </tr>
    <tr>
      <td colspan="2"><strong>Prompt 8 · Explore live data</strong><br><br>Build an accessible color palette lab. Include HSL sliders, five live swatches with hex values, a foreground/background contrast checker, and AA/AAA status badges. Make it vivid, compact, and polished; no web search.</td>
    </tr>
    <tr>
      <td valign="top"><img src="docs/images/markdown-color-lab.png" alt="A Markdown-only response containing a complete accessibility color lab implementation" width="420"><br><sub><a href="docs/markdown-examples/color-lab.md">Markdown source</a></sub></td>
      <td valign="top"><img src="docs/images/color-lab.png" alt="An interactive accessibility color lab rendered by ChatHTML" width="420"><br><sub><a href="https://chat.aietheia.com/artifacts/share-mrov32ve-ba8df4a93c2d4a409c">Live example</a> · <a href="docs/examples/color-lab.chathtml.html">Generated source</a></sub></td>
    </tr>
  </tbody>
</table>

Generate or refresh the stored OpenRouter responses:

```bash
node scripts/generate-readme-markdown-examples.mjs
```

The generator submits each stored prompt directly as the only input, without a
system instruction or response-format guidance. It defaults to
`google/gemini-3.1-pro-preview`; set `CHATHTML_README_MARKDOWN_MODEL` to override
it. This command invokes the provider and uses provider credits. To regenerate
one or more examples, pass their slugs as arguments.

Render the stored Markdown answers as plain screenshots without a provider call:

```bash
node scripts/render-readme-markdown-examples.mjs
```

To create or refresh a ChatHTML example while the dev server is running:

```bash
node scripts/generate-readme-example.mjs \
  "example-slug" \
  "Your prompt" \
  "docs/images/example-slug.png"
```

The ChatHTML generator uses the normal server prompt, provider request,
streaming protocol, persistence layer, and iframe renderer. It writes the raw
response to `docs/examples/<slug>.chathtml.html`. It defaults to
`google/gemini-3.1-pro-preview`; set `CHATHTML_README_MODEL` to override it. The
command invokes the provider and therefore uses provider credits.

Publish generated examples to stable hosted share links:

```bash
npx tsx scripts/share-readme-examples.ts example-slug
```

The publisher wraps each saved ChatHTML response in the same sandbox document
used by the app, then creates or updates its stable link on
`https://chat.aietheia.com`. Omit the slugs to publish every README example; set
`CHATHTML_README_SHARE_ORIGIN` to use another compatible host.

## How it works

```mermaid
flowchart LR
    A[User prompt] --> B[ChatHTML server]
    B --> C{Responses tool loop}
    C -->|retrieve, files, memory| C
    C --> D[NDJSON reasoning + content stream]
    D --> E[Protocol parser]
    E --> F[Partial HTML completion]
    F --> G[Sandboxed iframe]
```

1. The client sends the conversation, canvas size, theme, files, and provider
   settings to `POST /api/chat`.
2. The backend adds ChatHTML's system, canvas, theme, legibility, memory, and
   file context before calling a Responses-compatible model endpoint.
3. Model tool calls are executed in the same response loop. Reasoning and
   content are returned to the browser as sequenced NDJSON events.
4. The client extracts the protocol tags and feeds `<streamui>` content to the
   streaming renderer. Incomplete tags are safely completed for each preview
   frame.
5. Once the stream is complete, scripts and artifact actions are enabled in a
   fresh sandbox document.

## Capabilities

| Area | What is included |
| --- | --- |
| Rendering | Progressive HTML/CSS rendering, speculative completion, light/dark theme context, responsive canvas sizing |
| Interaction | Vanilla JavaScript, local controls, conversation actions, copy/download/open-link capability requests |
| Authoring | Region selection, targeted artifact edits, regeneration branches, screenshot-based visual repair |
| Retrieval | Brave, Tavily, Serper, DuckDuckGo fallback, direct URL fetching, optional Playwright browsing |
| Visual sources | Openverse, Wikimedia-oriented search, NASA, Library of Congress, The Met, Art Institute of Chicago, plus optional Pexels, Unsplash, and Rijksmuseum providers |
| Files | Draft image uploads, multimodal image reads, session file tools, capability URLs, saved raw artifact source |
| Persistence | SQLite for zero-setup local use; PostgreSQL with per-user state and concurrent access for production |
| Export | Copy source/text, standalone HTML, PNG, SVG, diagnostics, and optional hosted share links |

## Provider and key modes

| Mode | Request path | Secret handling | Best for |
| --- | --- | --- | --- |
| Environment | Browser to ChatHTML server to provider | Key remains in server environment | Local development and self-hosting |
| Manual | Browser directly to provider | Key is kept in browser `sessionStorage` | Signed-out use with a CORS-capable provider |
| Managed | Browser to authenticated ChatHTML Service gateway | Opaque service session stays in an HttpOnly cookie | Hosted deployments |

Manual mode never falls back through the ChatHTML server. Non-secret provider
settings are kept in local storage, while the key disappears with the browser
session. Plain HTTP provider URLs are rejected except for loopback development
endpoints.

## Configuration

The complete, annotated list lives in [`.env.example`](.env.example). The most
useful settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | none | Server-side OpenRouter credential |
| `OPENROUTER_MODEL` | `google/gemini-3.1-pro-preview` | Default generation model |
| `OPENROUTER_REASONING_EFFORT` | `low` | `none`, `minimal`, `low`, `medium`, or `high` |
| `STREAMUI_RETRIEVAL` | `true` | Enable the model's native retrieval tool |
| `STREAMUI_SEARCH_PROVIDER` | `auto` | Search provider selection |
| `STREAMUI_BROWSER_ENGINE` | `fetch` | Use `fetch` or Playwright for page retrieval |
| `STREAMUI_SESSION_DB` | `./sessions/state.sqlite` | SQLite state file |
| `CHATHTML_DATABASE_URL` | none | PostgreSQL connection string for production |
| `CHATHTML_AUTH_REQUIRED` | false outside production | Require a hosted account |
| `CHATHTML_ADMIN_USER_IDS` | none | Explicit account-ID allowlist for admin-only APIs |

With `STREAMUI_SEARCH_PROVIDER=auto`, configured API providers are preferred
and DuckDuckGo can be used as a fallback. Several visual and museum sources work
without keys; optional provider keys expand coverage.

The retrieval policy blocks private network targets by default. Domain allow
and block lists, timeouts, page limits, and context budgets are configurable in
`.env`.

## Persistence

SQLite is the zero-setup default. It uses WAL mode and a serialized write queue,
which is appropriate for local development and small single-instance installs.
Place the database on persistent storage if the deployment filesystem is
ephemeral:

```dotenv
STREAMUI_SESSION_DB=/data/chathtml/state.sqlite
```

Use PostgreSQL for a hosted or horizontally scaled deployment:

```dotenv
CHATHTML_DATABASE_URL=postgresql://chathtml_app:password@127.0.0.1:5432/chathtml
CHATHTML_DATABASE_POOL_SIZE=10
CHATHTML_AUTH_REQUIRED=true
```

PostgreSQL stores one atomic state row per authenticated user, serializes
updates for the same user with a row lock, and allows different users to read
and write concurrently.

To migrate legacy SQLite data into an existing account, back up the source and
run:

```bash
STREAMUI_SESSION_DB=/data/chathtml/state.sqlite \
CHATHTML_DATABASE_URL=postgresql://... \
CHATHTML_MIGRATION_USER_ID=00000000-0000-4000-8000-000000000000 \
npm run migrate:sessions
```

The migration is transactional and idempotent. It verifies counts and hashes,
refuses to overwrite non-empty target data, and rotates stored file
capabilities.

## Runtime protocol

The wire protocol retains the legacy `<streamui>` name for compatibility with
existing sessions and renderer code:

```html
<sessiontitle>Concise history title</sessiontitle>
<chat></chat>

<streamui>
  <section class="streamui-response">
    <div class="streamui-chat">
      <p>All user-facing content lives in this artifact.</p>
    </div>
  </section>
  <script>
    // Optional small vanilla JavaScript. Runs after completion.
  </script>
</streamui>
```

- `<sessiontitle>` becomes the hidden history title.
- `<chat>` remains empty for visual responses; it is used as a fallback for
  non-artifact text.
- `<streamui>` is rendered chunk by chunk and must remain open until the
  artifact is finished.
- Built-in `streamui-*` classes and CSS variables provide accessible prose,
  buttons, muted text, actions, and theme-aware colors.
- Scripts are ignored during streaming and run only after a complete artifact
  has been installed in the iframe.

If a response has no valid `<streamui>` block, it is displayed as a normal
assistant message.

### Artifact actions

Generated controls can ask the host to perform safe actions without calling
sensitive browser APIs directly:

```html
<button data-streamui-prompt="Show a simpler example">Simplify</button>
<button data-streamui-copy-target="#result">Copy result</button>
<button
  data-streamui-download-target="#result"
  data-streamui-filename="result.txt"
>Download</button>
<button data-streamui-open-url="https://example.com">Open source</button>
```

The host confirms capability actions and performs them outside the artifact.

## Security model

- Server-managed provider credentials are never serialized into frontend
  settings.
- Artifacts render with
  `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`.
- The iframe CSP permits required HTTPS resources while disabling objects,
  forms, and base URL changes.
- Browser storage, cookies, parent/top/opener access, permissions APIs,
  `document.write`, and clipboard reads are blocked or reported by the runtime.
- Session files use stable IDs and unguessable capability URLs. Draft files are
  invisible to model file tools until the user sends the message.
- Hosted session ownership comes from the authenticated server identity, never
  from a browser-supplied client ID.

The sandbox is a defense boundary for generated artifacts, not permission to
run untrusted modifications to the ChatHTML host itself. Review the policy and
deployment configuration before exposing a customized runtime publicly.

## Sharing artifacts

Standalone HTML hosting is supplied by the separate
[`aietheia/oops`](https://github.com/aietheia/oops) service. A production proxy
should route `POST /api/html-shares` and `/artifacts/*` to that service. Share
Link is hidden by default; enable it only after those routes exist:

```dotenv
VITE_CHATHTML_ARTIFACT_SHARE_LINKS=true
```

Local HTML, PNG, and SVG export works without the hosting service.

## Development

This repository is an npm workspace:

| Path | Purpose |
| --- | --- |
| [`apps/web`](apps/web) | Full Vite/React client and Express backend |
| [`apps/webdemo`](apps/webdemo) | Browser-local, reduced Web Demo surface |
| [`docs/cloud-api.md`](docs/cloud-api.md) | Hosted HTTP and native-auth contracts |
| [`ops/production`](ops/production) | Backup, monitoring, systemd, and Nginx assets |

Useful commands:

```bash
npm run dev                 # full app on :5173, API on :8787
npm run dev:webdemo         # reduced web demo on :5174
npm test                    # web client and server unit tests
npm run test:webdemo        # web demo unit tests
npm run test:e2e            # Playwright browser suite
npm run build               # type-check and production build
```

Important implementation entry points:

- [`apps/web/src/server/systemPrompt.ts`](apps/web/src/server/systemPrompt.ts) —
  model behavior and output contract
- [`apps/web/server/openrouterChatExecution.ts`](apps/web/server/openrouterChatExecution.ts)
  — Responses API tool loop and stream generation
- [`apps/web/src/runtime/streamui/protocol.ts`](apps/web/src/runtime/streamui/protocol.ts)
  — protocol extraction
- [`apps/web/src/runtime/streamui/streamingRenderer.ts`](apps/web/src/runtime/streamui/streamingRenderer.ts)
  — progressive renderer lifecycle
- [`apps/web/src/runtime/streamui/sandboxDocument.ts`](apps/web/src/runtime/streamui/sandboxDocument.ts)
  — iframe document, CSP, and sandbox runtime
- [`apps/web/server/retrieval.ts`](apps/web/server/retrieval.ts) — search,
  fetching, parsing, and retrieval context
- [`apps/web/server/sessionRepository.ts`](apps/web/server/sessionRepository.ts)
  — SQLite/PostgreSQL persistence

## Production checks

The production browser audits create disposable accounts and the full audit
runs one managed generation. They modify production data and therefore require
an explicit flag:

```bash
node scripts/auth-relogin-repro.mjs --confirm-production-audit
node scripts/production-alpha-audit.mjs --confirm-production-audit
```

Reports are written to the ignored `test-results/` directory. Both scripts
delete their test account before exiting and return a non-zero status if the
audit is not clean. Use `CHATHTML_AUDIT_APP_BASE` and
`CHATHTML_AUDIT_SERVICE_BASE` to target a non-default environment.

For hosted authentication, account, and native-wrapper integration, see the
[Cloud API contract](docs/cloud-api.md). For operational assets and backup
expectations, see [Production operations](ops/production/README.md).

## Feedback

Bug reports can be submitted in the app, or opened directly in
[GitHub Issues](https://github.com/aietheia/ChatHTML/issues).
