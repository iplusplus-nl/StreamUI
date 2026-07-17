import { readFile } from "node:fs/promises";
import { buildIframeDocument } from "../apps/web/src/runtime/streamui/sandboxDocument";
import { README_COMPARISON_EXAMPLES } from "./readme-comparison-prompts.mjs";

const shareOrigin = (
  process.env.CHATHTML_README_SHARE_ORIGIN || "https://chat.aietheia.com"
).replace(/\/$/, "");
const requestedSlugs = new Set(process.argv.slice(2));
const examples = requestedSlugs.size
  ? README_COMPARISON_EXAMPLES.filter((example) =>
      requestedSlugs.has(example.slug)
    )
  : README_COMPARISON_EXAMPLES;

if (!examples.length) {
  throw new Error("No README examples matched the requested slugs.");
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) =>
      part === "2048" ? part : `${part[0].toUpperCase()}${part.slice(1)}`
    )
    .join(" ");
}

for (const example of examples) {
  const source = await readFile(
    `docs/examples/${example.slug}.chathtml.html`,
    "utf8"
  );
  const response = await fetch(`${shareOrigin}/api/html-shares`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      html: buildIframeDocument(source, "night"),
      sourceMessageId: `chathtml-readme-${example.slug}`,
      themeMode: "night",
      title: titleFromSlug(example.slug)
    })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    reused?: unknown;
    url?: unknown;
  };

  if (!response.ok || typeof payload.url !== "string") {
    throw new Error(
      `Sharing ${example.slug} failed (${response.status}): ${
        typeof payload.error === "string"
          ? payload.error
          : JSON.stringify(payload)
      }`
    );
  }

  console.log(
    `${example.slug}: ${payload.url}${payload.reused ? " (updated)" : ""}`
  );
}
