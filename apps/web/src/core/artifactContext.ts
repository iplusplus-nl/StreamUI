import { extractStreamUiParts } from "../runtime/streamui/protocol";

export type ArtifactContext = {
  id: string;
  sourceHash: string;
  sourceChars: number;
  textSummary: string;
  styleSummary: string;
  structureSummary: string;
  editableSummary: string;
};

const MAX_TEXT_SUMMARY_CHARS = 1_600;
const MAX_STYLE_SUMMARY_CHARS = 1_000;
const MAX_STRUCTURE_SUMMARY_CHARS = 1_000;
const MAX_EDITABLE_SUMMARY_CHARS = 1_200;
const MAX_LIST_ITEMS = 12;

function decodeHtmlEntities(value: string): string {
  if (typeof document === "undefined") {
    return value;
  }

  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  const compact = compactText(value);
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36).padStart(7, "0");
}

function uniqueValues(values: string[], limit = MAX_LIST_ITEMS): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const compact = compactText(value);
    const key = compact.toLowerCase();
    if (!compact || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(compact);
    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function summarizeCounts(values: string[], limit = MAX_LIST_ITEMS): string {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = value.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => (count > 1 ? `${value} x${count}` : value))
    .join(", ");
}

function matchAllGroups(
  value: string,
  regex: RegExp,
  groupSelector: (match: RegExpMatchArray) => string | undefined
): string[] {
  const matches: string[] = [];

  for (const match of value.matchAll(regex)) {
    const group = groupSelector(match);
    if (group) {
      matches.push(group);
    }
  }

  return matches;
}

export function htmlToTranscriptText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractClassNames(html: string): string[] {
  return matchAllGroups(
    html,
    /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match) => match[1] ?? match[2] ?? match[3]
  ).flatMap((className) => className.split(/\s+/).filter(Boolean));
}

function extractAttributeValues(html: string, attributeName: string): string[] {
  return matchAllGroups(
    html,
    new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi"),
    (match) => match[1] ?? match[2] ?? match[3]
  );
}

function stripNestedMarkup(value: string): string {
  return htmlToTranscriptText(value.replace(/<[^>]+>/g, " "));
}

function buildStructureSummary(html: string): string {
  const tags = matchAllGroups(html, /<\s*([a-z][a-z0-9-]*)\b/gi, (match) => match[1]);
  const classes = uniqueValues(extractClassNames(html), 10);
  const headings = uniqueValues(
    matchAllGroups(html, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (match) =>
      stripNestedMarkup(match[1] ?? "")
    ),
    6
  );
  const landmarks = uniqueValues(
    tags.filter((tag) =>
      [
        "header",
        "main",
        "section",
        "article",
        "nav",
        "aside",
        "footer",
        "canvas",
        "svg"
      ].includes(tag.toLowerCase())
    ),
    8
  );
  const pieces = [
    summarizeCounts(tags) ? `tags: ${summarizeCounts(tags)}` : "",
    landmarks.length ? `landmarks: ${landmarks.join(", ")}` : "",
    classes.length ? `classes: ${classes.join(", ")}` : "",
    headings.length ? `headings: ${headings.join(" | ")}` : ""
  ].filter(Boolean);

  return truncate(pieces.join("; "), MAX_STRUCTURE_SUMMARY_CHARS);
}

function buildStyleSummary(html: string): string {
  const styleBlocks = matchAllGroups(
    html,
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    (match) => match[1]
  );
  const inlineStyles = extractAttributeValues(html, "style");
  const styleText = compactText([...styleBlocks, ...inlineStyles].join(" "));
  const colors = uniqueValues(
    matchAllGroups(
      styleText,
      /(#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|var\(--[^)]+\))/gi,
      (match) => match[1]
    ),
    10
  );
  const properties = uniqueValues(
    matchAllGroups(styleText, /\b([a-z-]+)\s*:/gi, (match) => match[1]),
    12
  );
  const layoutHints = uniqueValues(
    matchAllGroups(
      styleText,
      /\b(grid|flex|absolute|fixed|sticky|relative|gap|border-radius|box-shadow|linear-gradient|font-family|font-size|aspect-ratio|overflow|backdrop-filter)\b/gi,
      (match) => match[1]
    ),
    10
  );
  const pieces = [
    colors.length ? `colors: ${colors.join(", ")}` : "",
    properties.length ? `css properties: ${properties.join(", ")}` : "",
    layoutHints.length ? `layout/style hints: ${layoutHints.join(", ")}` : ""
  ].filter(Boolean);

  return truncate(pieces.join("; "), MAX_STYLE_SUMMARY_CHARS);
}

function countTags(html: string, tagName: string): number {
  const matches = html.match(new RegExp(`<\\s*${tagName}\\b`, "gi"));
  return matches?.length ?? 0;
}

function buildEditableSummary(html: string, textSummary: string): string {
  const buttons = uniqueValues(
    matchAllGroups(html, /<button[^>]*>([\s\S]*?)<\/button>/gi, (match) =>
      stripNestedMarkup(match[1] ?? "")
    ),
    6
  );
  const links = uniqueValues(
    matchAllGroups(html, /<a\b[^>]*>([\s\S]*?)<\/a>/gi, (match) =>
      stripNestedMarkup(match[1] ?? "")
    ),
    6
  );
  const imageAlts = uniqueValues(extractAttributeValues(html, "alt"), 6);
  const counts = [
    `buttons: ${countTags(html, "button")}`,
    `links: ${countTags(html, "a")}`,
    `images: ${countTags(html, "img")}`,
    `forms: ${countTags(html, "form") + countTags(html, "input") + countTags(html, "textarea") + countTags(html, "select")}`,
    `scripts: ${countTags(html, "script")}`
  ].join(", ");
  const pieces = [
    textSummary ? `visible text: ${textSummary}` : "visible text: none",
    `editable/content elements: ${counts}`,
    buttons.length ? `button labels: ${buttons.join(" | ")}` : "",
    links.length ? `link labels: ${links.join(" | ")}` : "",
    imageAlts.length ? `image alts: ${imageAlts.join(" | ")}` : ""
  ].filter(Boolean);

  return truncate(pieces.join("; "), MAX_EDITABLE_SUMMARY_CHARS);
}

export function buildArtifactContext(raw: string): ArtifactContext | undefined {
  const parts = extractStreamUiParts(raw);
  const source = (parts.hasStreamUi ? parts.streamui : raw).trim();

  if (!source) {
    return undefined;
  }

  const sourceHash = stableHash(source);
  const textSummary = truncate(htmlToTranscriptText(source), MAX_TEXT_SUMMARY_CHARS);
  const styleSummary = buildStyleSummary(source);
  const structureSummary = buildStructureSummary(source);

  return {
    id: `artifact-${sourceHash}`,
    sourceHash,
    sourceChars: source.length,
    textSummary,
    styleSummary,
    structureSummary,
    editableSummary: buildEditableSummary(source, textSummary)
  };
}
