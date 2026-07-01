import type { ExtractedStreamUiParts } from "./types";

function extractBetween(
  raw: string,
  tagName: "chat" | "streamui"
): { content: string; hasOpen: boolean; hasClose: boolean } {
  const lower = raw.toLowerCase();
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const openIndex = lower.indexOf(openTag);

  if (openIndex === -1) {
    return { content: "", hasOpen: false, hasClose: false };
  }

  const contentStart = openIndex + openTag.length;
  const closeIndex = lower.indexOf(closeTag, contentStart);

  if (closeIndex === -1) {
    return {
      content: raw.slice(contentStart),
      hasOpen: true,
      hasClose: false
    };
  }

  return {
    content: raw.slice(contentStart, closeIndex),
    hasOpen: true,
    hasClose: true
  };
}

function removeProtocolTags(raw: string): string {
  return raw
    .replace(/<\/?chat>/gi, "")
    .replace(/<streamui>[\s\S]*?<\/streamui>/gi, "")
    .replace(/<streamui>[\s\S]*$/gi, "")
    .trim();
}

export function extractStreamUiParts(raw: string): ExtractedStreamUiParts {
  const chat = extractBetween(raw, "chat");
  const streamui = extractBetween(raw, "streamui");
  const fallbackText = chat.hasOpen
    ? chat.content.trim()
    : removeProtocolTags(raw);

  return {
    chat: chat.content.trim(),
    streamui: streamui.content,
    hasChat: chat.hasOpen,
    hasStreamUi: streamui.hasOpen,
    streamUiComplete: streamui.hasClose,
    fallbackText
  };
}
