import { mkdir, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { README_COMPARISON_EXAMPLES } from "./readme-comparison-prompts.mjs";

dotenv.config();

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is required to generate Markdown examples.");
}

const model =
  process.env.CHATHTML_README_MARKDOWN_MODEL?.trim() ||
  "google/gemini-3.1-pro-preview";
const requestedSlugs = new Set(process.argv.slice(2));
const examples = requestedSlugs.size
  ? README_COMPARISON_EXAMPLES.filter((example) =>
      requestedSlugs.has(example.slug)
    )
  : README_COMPARISON_EXAMPLES;

if (!examples.length) {
  throw new Error("No README comparison examples matched the requested slugs.");
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string") {
    return payload.output_text;
  }

  const text = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (
        (content?.type === "output_text" || content?.type === "text") &&
        typeof content.text === "string"
      ) {
        text.push(content.text);
      }
    }
  }

  if (text.length) {
    return text.join("\n");
  }

  const chatContent = payload?.choices?.[0]?.message?.content;
  return typeof chatContent === "string" ? chatContent : "";
}

async function generateMarkdown(example) {
  const response = await fetch("https://openrouter.ai/api/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/aietheia/ChatHTML",
      "X-Title": "ChatHTML README comparison"
    },
    body: JSON.stringify({
      model,
      input: example.prompt,
      max_output_tokens: 32_000
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const detail = payload?.error?.message || JSON.stringify(payload);
    throw new Error(`Markdown generation failed (${response.status}): ${detail}`);
  }

  const markdown = extractOutputText(payload)
    .trim()
    .replace(/[\t ]+$/gm, "");
  if (!markdown) {
    throw new Error(`Markdown generation returned no text for ${example.slug}.`);
  }
  return markdown;
}

await mkdir("docs/markdown-examples", { recursive: true });

for (const example of examples) {
  process.stdout.write(`Generating ${example.slug} with ${model}... `);
  const markdown = await generateMarkdown(example);
  await writeFile(
    `docs/markdown-examples/${example.slug}.md`,
    `${markdown}\n`,
    "utf8"
  );
  console.log(`${markdown.length} chars`);
}
