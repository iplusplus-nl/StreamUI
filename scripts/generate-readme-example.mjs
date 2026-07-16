import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";

const [slug, prompt, artifactPath, appPath] = process.argv.slice(2);
if (!slug || !prompt || !artifactPath) {
  throw new Error(
    "Usage: node scripts/generate-readme-example.mjs <slug> <prompt> <artifact.png> [app.png]"
  );
}

const appOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:8787";
const clientId = "readme-examples";
const model =
  process.env.CHATHTML_README_MODEL?.trim() ||
  "google/gemini-3.1-pro-preview";
const now = Date.now();
const sessionId = `readme-${slug}-${now}`;
const runId = `run-${slug}-${now}`;
const userId = `user-${slug}-${now}`;
const assistantId = `assistant-${slug}-${now}`;

const response = await fetch(`${apiOrigin}/api/chat`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-ChatHTML-Client-Id": clientId
  },
  body: JSON.stringify({
    clientId,
    sessionId,
    runId,
    userMessage: {
      id: userId,
      role: "user",
      content: prompt,
      status: "complete"
    },
    assistantMessage: {
      id: assistantId,
      role: "assistant",
      content: "",
      rawStream: "",
      generationRunId: runId,
      streamSequence: 0,
      status: "streaming"
    },
    messages: [{ role: "user", content: prompt }],
    files: [],
    canvas: {
      viewportWidth: 1440,
      viewportHeight: 1100,
      canvasWidth: 960,
      initialCanvasHeight: 700,
      devicePixelRatio: 1
    },
    themeMode: "night",
    apiSettings: {
      providerId: "openrouter",
      providerName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeySource: "environment",
      model,
      reasoningEffort: "low",
      uiComplexity: 70,
      userPreferencePrompt: "",
      memoryItems: []
    },
    searchSettings: { enabled: false }
  })
});

if (!response.ok || !response.body) {
  throw new Error(`ChatHTML generation failed (${response.status}): ${await response.text()}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let rawStream = "";
let terminalStatus = "";
let terminalError = "";

function consumeLine(line) {
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.type === "content" && typeof event.text === "string") {
    rawStream += event.text;
  }
  if (event.type === "done") {
    terminalStatus = event.status || "complete";
    terminalError = event.error || "";
  }
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  lines.forEach(consumeLine);
}
buffer += decoder.decode();
if (buffer.trim()) consumeLine(buffer);

if (terminalStatus !== "complete" || !rawStream.includes("<streamui>")) {
  throw new Error(
    `ChatHTML returned status=${terminalStatus || "unknown"}: ${terminalError || "no artifact"}`
  );
}

await mkdir("docs/examples", { recursive: true });
const normalizedRawStream = rawStream.replace(/[\t ]+$/gm, "");
await writeFile(
  `docs/examples/${slug}.chathtml.html`,
  normalizedRawStream,
  "utf8"
);
await mkdir(dirname(artifactPath), { recursive: true });
if (appPath) await mkdir(dirname(appPath), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1
  });
  await context.addInitScript((id) => {
    localStorage.setItem("streamui.clientId.v1", id);
  }, clientId);
  const page = await context.newPage();
  await page.goto(appOrigin, { waitUntil: "networkidle" });

  const artifact = page.locator("iframe.preview-frame").last();
  await artifact.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(2_000);
  console.log("ARTIFACT", await artifact.boundingBox());
  await artifact.screenshot({ path: artifactPath });

  if (appPath) {
    await page.addStyleTag({
      content: ".session-list-item:not(.is-active) { display: none !important; }"
    });
    await artifact.scrollIntoViewIfNeeded();
    await page.screenshot({ path: appPath });
  }
} finally {
  await browser.close();
}
