const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

type CompletionOptions = {
  allowScripts?: boolean;
  allowPartialStyles?: boolean;
};

const WIKIMEDIA_DISPLAY_IMAGE_WIDTH = 1280;
const MAX_FILTER_BLUR_PX = 6;

function removeBrokenTrailingTag(input: string): string {
  const lastLt = input.lastIndexOf("<");
  const lastGt = input.lastIndexOf(">");

  if (lastLt > lastGt) {
    return input.slice(0, lastLt);
  }

  return input;
}

function stripScriptBlocks(input: string, allowScripts: boolean): string {
  const lower = input.toLowerCase();
  const lastOpen = lower.lastIndexOf("<script");
  const lastClose = lower.lastIndexOf("</script>");
  const stable =
    lastOpen > lastClose
      ? input.slice(0, lastOpen)
      : input;

  if (allowScripts) {
    return stable;
  }

  return stable.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

function stripUnsafeInlineAttributes(input: string): string {
  return input
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(
      /\s+(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi,
      " $1=\"#\""
    );
}

function wikimediaOriginalImageUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      !parsed.hostname.toLowerCase().endsWith("upload.wikimedia.org") ||
      !parsed.pathname.includes("/thumb/")
    ) {
      return undefined;
    }

    const withoutThumb = parsed.pathname.replace("/thumb/", "/");
    const lastSlash = withoutThumb.lastIndexOf("/");
    if (lastSlash <= 0) {
      return undefined;
    }

    parsed.pathname = withoutThumb.slice(0, lastSlash);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function wikimediaDisplayImageUrl(url: string): string | undefined {
  try {
    const originalUrl = wikimediaOriginalImageUrl(url) ?? url;
    const parsed = new URL(originalUrl);
    if (!parsed.hostname.toLowerCase().endsWith("upload.wikimedia.org")) {
      return undefined;
    }

    const match = parsed.pathname.match(/^(\/wikipedia\/[^/]+\/)(.+)$/);
    const filename = parsed.pathname.split("/").filter(Boolean).pop();
    if (!match || !filename || /\.svg$/i.test(filename)) {
      return undefined;
    }

    parsed.pathname = `${match[1]}thumb/${match[2]}/${WIKIMEDIA_DISPLAY_IMAGE_WIDTH}px-${filename}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function optimizeWikimediaImageUrl(url: string): string {
  return wikimediaDisplayImageUrl(url) ?? url;
}

function optimizeWikimediaImageUrls(input: string): string {
  return input.replace(
    /https:\/\/upload\.wikimedia\.org\/[^\s"'()<>]+/gi,
    (url) => optimizeWikimediaImageUrl(url)
  );
}

function stabilizeViewportHeightUnits(input: string): string {
  return input.replace(
    /\b(\d+(?:\.\d+)?)(dvh|svh|lvh|vh)\b/gi,
    (_match, rawValue: string, unit: string) => {
      const value = Number.parseFloat(rawValue);
      if (!Number.isFinite(value)) {
        return `${rawValue}${unit}`;
      }

      const px = Number((value * 7.2).toFixed(2));
      return `min(${rawValue}${unit}, ${px}px)`;
    }
  );
}

function capBlurFilterFunctions(value: string): string {
  return value.replace(
    /\bblur\(\s*([+-]?(?:\d+\.?\d*|\.\d+))px\s*\)/gi,
    (_match, rawValue: string) => {
      const px = Number.parseFloat(rawValue);

      if (!Number.isFinite(px) || px <= MAX_FILTER_BLUR_PX) {
        return `blur(${rawValue}px)`;
      }

      return `blur(${MAX_FILTER_BLUR_PX}px)`;
    }
  );
}

function stabilizeFilterDeclaration(_match: string, value: string): string {
  if (/\bdrop-shadow\s*\(/i.test(value)) {
    return "filter: none;";
  }

  return `filter: ${capBlurFilterFunctions(value.trim())};`;
}

function neutralizeExpensiveCssDeclarations(css: string): string {
  return css
    .replace(
      /\bbackground-attachment\s*:\s*fixed\b/gi,
      "background-attachment: scroll"
    )
    .replace(
      /\b(background(?:-image)?\s*:[^;{}]*?)\bfixed\b/gi,
      "$1scroll"
    )
    .replace(/\s*-webkit-backdrop-filter\s*:[^;{}]+;?/gi, "")
    .replace(/\s*backdrop-filter\s*:[^;{}]+;?/gi, "")
    .replace(
      /\bfilter\s*:\s*([^;{}]+);?/gi,
      stabilizeFilterDeclaration
    )
    .replace(/\bmix-blend-mode\s*:\s*(?!normal\b)[^;{}]+;?/gi, "mix-blend-mode: normal;");
}

function neutralizeExpensiveCss(input: string): string {
  return input
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_match, openTag: string, css: string, closeTag: string) =>
        `${openTag}${neutralizeExpensiveCssDeclarations(css)}${closeTag}`
    )
    .replace(
      /\sstyle=(["'])([^"']*)\1/gi,
      (_match, quote: string, css: string) =>
        ` style=${quote}${neutralizeExpensiveCssDeclarations(css)}${quote}`
    );
}

function closeIncompleteStyleBlock(
  input: string,
  allowPartialStyles: boolean
): string {
  const lower = input.toLowerCase();
  const lastOpen = lower.lastIndexOf("<style");
  const lastClose = lower.lastIndexOf("</style>");

  if (lastOpen <= lastClose) {
    return input;
  }

  const openEnd = input.indexOf(">", lastOpen);
  if (openEnd === -1) {
    return input.slice(0, lastOpen);
  }

  if (!allowPartialStyles) {
    return input.slice(0, lastOpen);
  }

  return `${input}\n</style>`;
}

function appendMissingClosers(input: string): string {
  const stack: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*)?>/g;
  const scanInput = input.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (_block, tagName: string) => `<${tagName}></${tagName}>`
  );
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(scanInput)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    if (
      fullTag.startsWith("<!") ||
      fullTag.startsWith("<?") ||
      VOID_TAGS.has(tagName)
    ) {
      continue;
    }

    if (fullTag.startsWith("</")) {
      const index = stack.lastIndexOf(tagName);
      if (index !== -1) {
        stack.splice(index);
      }
      continue;
    }

    if (fullTag.endsWith("/>")) {
      continue;
    }

    stack.push(tagName);
  }

  if (stack.length === 0) {
    return input;
  }

  return `${input}${stack
    .reverse()
    .map((tagName) => `</${tagName}>`)
    .join("")}`;
}

export function completePartialHtml(
  input: string,
  options: CompletionOptions = {}
): string {
  const allowScripts = options.allowScripts ?? false;
  const allowPartialStyles = options.allowPartialStyles ?? false;
  const withoutBrokenTail = removeBrokenTrailingTag(input);
  const withoutScripts = stripScriptBlocks(withoutBrokenTail, allowScripts);
  const withoutUnsafeAttributes = stripUnsafeInlineAttributes(withoutScripts);
  const withOptimizedImages = optimizeWikimediaImageUrls(withoutUnsafeAttributes);
  const withStableViewportUnits = stabilizeViewportHeightUnits(
    withOptimizedImages
  );
  const withClosedStyle = closeIncompleteStyleBlock(
    withStableViewportUnits,
    allowPartialStyles
  );
  const withPerformanceSafeCss = neutralizeExpensiveCss(withClosedStyle);

  return appendMissingClosers(withPerformanceSafeCss);
}
