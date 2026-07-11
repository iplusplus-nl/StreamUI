import {
  clip,
  decodeSearchText,
  parseAbsoluteUrl,
  uniqueStrings
} from "./retrievalPrimitives.js";
import type {
  RetrievalMessage,
  RetrievalOptions,
  SearchResult
} from "./retrievalTypes.js";
import {
  getRetrievalHostname,
  matchesRetrievalDomain
} from "./retrievalUrlPolicy.js";

export function extractRetrievalUrls(text: string): string[] {
  const urls = new Set<string>();
  const explicitUrlPattern =
    /\bhttps?:\/\/[^\s<>"'`)\]}]+|\bwww\.[^\s<>"'`)\]}]+/gi;

  for (const match of text.matchAll(explicitUrlPattern)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const normalized = parseAbsoluteUrl(
      raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw
    );
    if (normalized) {
      urls.add(normalized);
    }
  }

  return [...urls];
}

export function removeRetrievalUrls(text: string): string {
  return text.replace(
    /\bhttps?:\/\/[^\s<>"'`)\]}]+|\bwww\.[^\s<>"'`)\]}]+/gi,
    " "
  );
}

export function asksForVisualResources(text: string): boolean {
  return /\b(gallery|galleries|gallary|image|images|photo|photos|picture|pictures|pic|pics|screenshot|screenshots|wallpaper|wallpapers|visual reference|visual references|media assets?)\b|图片|照片|图集|图库|相册|壁纸|素材|视觉参考/i.test(
    text
  );
}

export function asksForRecentVisualResources(
  text: string,
  currentYear = new Date().getUTCFullYear()
): boolean {
  if (!asksForVisualResources(text)) {
    return false;
  }

  const freshnessCue =
    /\b(current|recent|latest|live|today|tonight|yesterday|this (?:week|weekend|month|year)|breaking|just happened|happening now)\b|\u6700\u65b0|\u4eca\u5929|\u6628\u5929|\u5b9e\u65f6|\u73b0\u573a|\u672c\u5468|\u8fd9\u5468|\u4eca\u5e74/i;
  const mentionedYears = Array.from(text.matchAll(/\b(?:19|20)\d{2}\b/g)).map(
    (match) => Number.parseInt(match[0], 10)
  );

  return freshnessCue.test(text) || mentionedYears.includes(currentYear);
}

export function shouldSearchRetrieval(
  text: string,
  options: Pick<RetrievalOptions, "forceSearch">,
  hasDirectUrls: boolean
): boolean {
  if (options.forceSearch) {
    return true;
  }

  if (hasDirectUrls) {
    const textWithoutUrls = removeRetrievalUrls(text);
    const urlCompanionCues =
      /\b(search|web|online|current|recent|latest|today|news|find related|related sources|more sources|other sources|references|images|photos|screenshots|assets|examples|alternatives|compare|official)\b|搜索|查一下|查询|最新|今天|现在|新闻|相关|更多来源|其他来源|参考|资料|图片|素材|例子|示例|对比|官网/i;

    return urlCompanionCues.test(textWithoutUrls);
  }

  const cues =
    /\b(current|recent|latest|today|tonight|tomorrow|yesterday|news|search|web|online|source|sources|reference|references|link|links|page|url|site|website|browse|fetch|read|lookup|look up|find|research|official|image|images|photo|photos|picture|pictures|pic|pics|gallery|galleries|gallary|screenshot|screenshots|wallpaper|wallpapers|media assets?|map|maps|weather|price|prices|schedule|release|version)\b|最新|今天|现在|新闻|搜索|查一下|查询|网页|网站|链接|来源|资料|参考|官网|浏览|读取|找|图片|照片|图集|图库|相册|壁纸|素材|地图|价格|日程|版本|发布|当前/i;

  return cues.test(text);
}

export function buildRetrievalSearchQuery(text: string): string {
  const explicitQuery = text.match(/(?:^|\n)\s*Search query:\s*([^\n]+)/i)?.[1];
  const original =
    clip(removeRetrievalUrls(explicitQuery || text), 260) ||
    clip(explicitQuery || text, 260) ||
    "";
  if (!original) {
    return "";
  }

  if (!asksForVisualResources(text)) {
    return original;
  }

  const cleaned = original
    .replace(
      /^\s*(?:please\s+)?(?:generate|create|make|build|design|write|show(?:\s+me)?)\s+(?:an?\s+|the\s+)?/i,
      ""
    )
    .replace(
      /^\s*(?:gallery|galleries|gallary|photo\s+gallery|image\s+gallery|picture\s+gallery)\s+(?:of|for)?\s*/i,
      ""
    )
    .replace(/^\s*(?:of|for)\s+/i, "")
    .replace(/\bphoto['’]s\b/gi, "photos")
    .trim();
  const query = cleaned || original;

  if (
    /\b(image|images|photo|photos|picture|pictures|gallery|galleries|wallpaper|wallpapers)\b/i.test(
      query
    )
  ) {
    return clip(query, 260) || query;
  }

  return clip(`${query} photos images`, 260) || query;
}

export function buildRetrievalSearchQueries(
  text: string,
  intentText = text
): string[] {
  const query = buildRetrievalSearchQuery(text);
  if (!query) {
    return [];
  }

  if (!asksForVisualResources(intentText)) {
    return [query];
  }

  if (asksForRecentVisualResources(intentText)) {
    const intentQuery = buildRetrievalSearchQuery(intentText) || query;
    const eventQuery =
      intentQuery
        .replace(
          /(?:[.!?]\s*|\s+)\b(?:i|we)\s+(?:like|prefer|want|love|am interested in|are interested in)\b[\s\S]*$/i,
          ""
        )
        .trim() || intentQuery;
    const coreTerms = new Set(visualRelevanceTerms(eventQuery));
    const focusedTerms = visualRelevanceTerms(query);
    const hasFocusedConstraint = focusedTerms.some(
      (term) => !coreTerms.has(term)
    );
    const focusedVisualQuery = hasFocusedConstraint
      ? /\b(?:image|images|photo|photos|picture|pictures|video|videos)\b/i.test(
          query
        )
        ? query
        : `${query} photos videos`
      : "";

    return uniqueStrings([
      eventQuery,
      focusedVisualQuery,
      `${eventQuery} site:instagram.com OR site:facebook.com OR site:tiktok.com recent posts photos reels`,
      `${eventQuery} site:youtube.com/watch videos`
    ]).slice(0, 4);
  }

  return uniqueStrings([
    query,
    `${query} Wikimedia Commons`,
    `${query} site:commons.wikimedia.org`
  ]).slice(0, 3);
}

export function buildRetrievalImageSearchQueries(
  text: string,
  intentText = text
): string[] {
  const baseQuery = buildRetrievalSearchQueries(text, intentText)[0];
  if (!baseQuery || !asksForVisualResources(intentText)) {
    return [];
  }

  return [baseQuery];
}

const VISUAL_RELEVANCE_STOP_WORDS = new Set([
  "and",
  "build",
  "cars",
  "create",
  "for",
  "gallery",
  "galleries",
  "image",
  "images",
  "like",
  "make",
  "media",
  "of",
  "photo",
  "photos",
  "picture",
  "pictures",
  "please",
  "show",
  "the",
  "video",
  "videos",
  "want",
  "with"
]);

function visualRelevanceTerms(text: string): string[] {
  const terms = decodeSearchText(text).match(/[a-z0-9]+/g) ?? [];
  return uniqueStrings(
    terms
      .filter(
        (term) =>
          term.length > 2 &&
          !/^\d{4}$/.test(term) &&
          !VISUAL_RELEVANCE_STOP_WORDS.has(term)
      )
      .map((term) => (term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term))
  );
}

function visualResultRelevance(result: SearchResult, text: string): number {
  const terms = visualRelevanceTerms(text);
  if (!terms.length) {
    return 0;
  }

  const haystack = decodeSearchText(
    `${result.url} ${result.title ?? ""} ${result.snippet ?? ""}`
  );
  return terms.reduce(
    (matches, term) => matches + (haystack.includes(term) ? 1 : 0),
    0
  );
}

function visualResultIdentityRelevance(
  result: SearchResult,
  text: string
): number {
  const terms = visualRelevanceTerms(text);
  if (!terms.length) {
    return 0;
  }

  const haystack = decodeSearchText(`${result.url} ${result.title ?? ""}`);
  return terms.reduce(
    (matches, term) => matches + (haystack.includes(term) ? 1 : 0),
    0
  );
}

export function visualRetrievalResultMatchesSubject(
  result: SearchResult,
  text: string,
  requireRequestedYear = true
): boolean {
  const terms = visualRelevanceTerms(text);
  const requiredTermMatches = terms.length
    ? Math.max(1, Math.ceil(terms.length * 0.75))
    : 0;
  if (
    requiredTermMatches > 0 &&
    visualResultIdentityRelevance(result, text) < requiredTermMatches
  ) {
    return false;
  }

  const identityHaystack = decodeSearchText(
    `${result.url} ${result.title ?? ""}`
  );
  const years = uniqueStrings(text.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  return (
    !requireRequestedYear ||
    years.every((year) => identityHaystack.includes(year))
  );
}

export function latestRetrievalUserText(
  messages: RetrievalMessage[]
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) {
      return message.content.trim();
    }
  }

  return "";
}

export function visualRetrievalResultScore(result: SearchResult): number {
  const hostname = getRetrievalHostname(result.url) ?? "";
  const haystack = decodeSearchText(
    `${result.url} ${result.title ?? ""} ${result.snippet ?? ""} ${result.provider}`
  );
  let score = 0;

  if (
    [
      "openverse",
      "pexels",
      "tavily-images",
      "unsplash",
      "nasa",
      "loc",
      "met",
      "artic",
      "rijksmuseum"
    ].includes(result.provider)
  ) {
    score += 90;
  } else if (matchesRetrievalDomain(hostname, "commons.wikimedia.org")) {
    score += 80;
  } else if (matchesRetrievalDomain(hostname, "wikimedia.org")) {
    score += 60;
  } else if (matchesRetrievalDomain(hostname, "wikipedia.org")) {
    score += 35;
  } else if (
    matchesRetrievalDomain(hostname, "openverse.org") ||
    matchesRetrievalDomain(hostname, "pexels.com") ||
    matchesRetrievalDomain(hostname, "unsplash.com") ||
    matchesRetrievalDomain(hostname, "nasa.gov") ||
    matchesRetrievalDomain(hostname, "loc.gov") ||
    matchesRetrievalDomain(hostname, "metmuseum.org") ||
    matchesRetrievalDomain(hostname, "artic.edu") ||
    matchesRetrievalDomain(hostname, "rijksmuseum.nl")
  ) {
    score += 70;
  } else if (matchesRetrievalDomain(hostname, "flickr.com")) {
    score += 20;
  }

  if (result.imageUrl) {
    score += 10;
  }

  if (/\b(?:photo|photos|image|images|gallery|commons|media|wallpaper)\b/i.test(haystack)) {
    score += 6;
  }

  if (/\b(?:getty|shutterstock|alamy|istock|adobe stock|stock photos?)\b/i.test(haystack)) {
    score -= 30;
  }

  return score;
}

export function prioritizeRetrievalSearchResults(
  results: SearchResult[],
  text: string,
  subjectText = text
): SearchResult[] {
  if (!asksForVisualResources(text)) {
    return results;
  }

  const recentVisuals = asksForRecentVisualResources(text);

  return [...results].sort(
    (a, b) =>
      visualResultRelevance(b, subjectText) * 45 -
        visualResultRelevance(a, subjectText) * 45 +
        (recentVisuals
          ? recentVisualSourceScore(b, subjectText) -
            recentVisualSourceScore(a, subjectText)
          : 0) +
        visualRetrievalResultScore(b) -
        visualRetrievalResultScore(a) ||
      a.rank - b.rank
  );
}

function recentVisualSourceScore(result: SearchResult, text: string): number {
  const hostname = getRetrievalHostname(result.url) ?? "";
  const subjectTerms = visualRelevanceTerms(text);
  const subjectMatches = visualResultRelevance(result, text);
  if (subjectTerms.length >= 2 && subjectMatches < 2) {
    return -140;
  }
  if (
    [
      "instagram.com",
      "facebook.com",
      "tiktok.com",
      "youtube.com",
      "youtu.be",
      "vimeo.com",
      "flickr.com"
    ].some((domain) => matchesRetrievalDomain(hostname, domain))
  ) {
    const pathname = (() => {
      try {
        return new URL(result.url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const isPostOrVideo =
      /\/(?:p|reel|reels|posts|photos|videos?|watch)\//.test(pathname) ||
      pathname === "/watch";
    return isPostOrVideo ? 110 : 30;
  }

  if (
    ["met", "artic", "nasa", "loc", "rijksmuseum", "openverse"].includes(
      result.provider
    ) && visualResultRelevance(result, text) === 0
  ) {
    return -40;
  }

  return 0;
}
