import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { README_COMPARISON_EXAMPLES } from "./readme-comparison-prompts.mjs";

const outputDirectory = "docs/images";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  const code = [];
  let html = escapeHtml(value).replace(/`([^`]+)`/g, (_match, content) => {
    const token = `ZXQCODE${code.length}QXZ`;
    code.push(`<code>${content}</code>`);
    return token;
  });

  html = html
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      '<img src="$2" alt="$1">'
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2">$1</a>'
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");

  return html.replace(/ZXQCODE(\d+)QXZ/g, (_match, index) => code[index]);
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
    line
  );
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^```([\w+-]*)(?:\s+.*)?\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      closeList();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[1]
        ? ` data-language="${escapeHtml(fence[1])}"`
        : "";
      html.push(
        `<pre${language}><code>${escapeHtml(code.join("\n"))}</code></pre>`
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr>");
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1])
    ) {
      flushParagraph();
      closeList();
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push("<table><thead><tr>");
      headers.forEach((cell) => html.push(`<th>${renderInline(cell)}</th>`));
      html.push("</tr></thead><tbody>");
      rows.forEach((row) => {
        html.push("<tr>");
        row.forEach((cell) => html.push(`<td>${renderInline(cell)}</td>`));
        html.push("</tr>");
      });
      html.push("</tbody></table>");
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextListType = unordered ? "ul" : "ol";
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  return html.join("\n");
}

const styles = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    width: 852px;
    margin: 0;
    overflow: hidden;
    background: #202123;
  }
  body {
    padding: 36px 42px;
    color: #ececf1;
    font: 19px/1.62 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  article { width: 100%; }
  p { margin: 0 0 20px; }
  h1, h2, h3, h4 { margin: 28px 0 12px; color: #fff; line-height: 1.25; }
  h1 { margin-top: 0; font-size: 30px; }
  h2 { font-size: 25px; }
  h3 { font-size: 21px; }
  ul, ol { margin: 0 0 22px; padding-left: 29px; }
  li { margin: 7px 0; padding-left: 4px; }
  a { color: #8ab4f8; text-decoration: underline; }
  strong { color: #fff; }
  code {
    padding: 0.12em 0.32em;
    border-radius: 4px;
    color: #e3e3e8;
    background: #343438;
    font: 0.86em/1.5 "Cascadia Code", Consolas, monospace;
  }
  pre {
    position: relative;
    margin: 22px 0;
    padding: 20px 22px;
    overflow: hidden;
    border: 1px solid #444448;
    border-radius: 8px;
    background: #111113;
    white-space: pre;
  }
  pre code {
    padding: 0;
    border-radius: 0;
    background: transparent;
    font-size: 14px;
  }
  blockquote {
    margin: 20px 0;
    padding: 3px 0 3px 18px;
    color: #c8c8cf;
    border-left: 3px solid #6d6d75;
  }
  table { width: 100%; margin: 22px 0; border-collapse: collapse; font-size: 16px; }
  th, td { padding: 10px 12px; text-align: left; border: 1px solid #4a4a50; }
  th { color: #fff; background: #303034; }
  hr { height: 1px; margin: 28px 0; border: 0; background: #4a4a50; }
  img { display: block; max-width: 100%; max-height: 420px; margin: 20px 0; object-fit: cover; }
`;

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 852, height: 944 },
    deviceScaleFactor: 1
  });

  for (const example of README_COMPARISON_EXAMPLES) {
    const markdown = await readFile(
      `docs/markdown-examples/${example.slug}.md`,
      "utf8"
    );
    await page.setViewportSize({
      width: 852,
      height: example.markdownImageHeight
    });
    await page.setContent(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><style>${styles}</style></head>
        <body><article>${renderMarkdown(markdown)}</article></body>
      </html>`);
    await page.screenshot({
      path: `${outputDirectory}/markdown-${example.slug}.png`
    });
  }
} finally {
  await browser.close();
}
