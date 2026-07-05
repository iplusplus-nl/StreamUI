import type { Request, Response } from "express";
import { load } from "cheerio";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";

const DEFAULT_RETRIEVAL_ENABLED = true;
const DEFAULT_SEARCH_PROVIDER = "auto";
const DEFAULT_SEARCH_MAX_RESULTS = 5;
const DEFAULT_FETCH_MAX_PAGES = 4;
const DEFAULT_PAGE_MAX_CHARS = 10_000;
const DEFAULT_CONTEXT_MAX_CHARS = 32_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_BROWSER_ENGINE = "fetch";
const DEFAULT_ALLOW_DUCKDUCKGO_FALLBACK = true;
const DEFAULT_ALLOW_PRIVATE_URLS = false;
const DEFAULT_MAX_LINKS_PER_PAGE = 24;
const DEFAULT_MAX_IMAGES_PER_PAGE = 18;
const USER_AGENT =
  "StreamUI-Retrieval/0.1 (+https://localhost; local development retrieval service)";
const IMAGE_USER_AGENT =
  "Mozilla/5.0 (compatible; StreamUI-Retrieval/0.1; +https://stream.aiz.ink)";
const require = createRequire(import.meta.url);

type SearchProvider = "auto" | "brave" | "tavily" | "serper" | "duckduckgo" | "none";
type BrowserEngine = "fetch" | "playwright";
type ApiKeySource = "environment" | "manual";

export type RetrievalMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RetrievedImage = {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  creator?: string;
  credit?: string;
  license?: string;
  licenseUrl?: string;
};

export type RetrievedLink = {
  url: string;
  text?: string;
};

export type RetrievalSource = {
  id: number;
  kind: "search-result" | "page";
  url: string;
  finalUrl?: string;
  title?: string;
  snippet?: string;
  text?: string;
  siteName?: string;
  provider?: string;
  searchRank?: number;
  status?: number;
  contentType?: string;
  fetchedAt?: string;
  images: RetrievedImage[];
  links: RetrievedLink[];
  error?: string;
};

export type RetrievalContext = {
  enabled: boolean;
  used: boolean;
  reason: string;
  nowIso: string;
  searchProvider?: string;
  queries: string[];
  urls: string[];
  sources: RetrievalSource[];
  verifiedImages: VerifiedImage[];
  notes: string[];
};

type VerifiedImage = RetrievedImage & {
  sourceId: number;
  sourceTitle?: string;
  sourceUrl: string;
  contentType?: string;
};

type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
  imageUrl?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageCreator?: string;
  imageCredit?: string;
  imageLicense?: string;
  imageLicenseUrl?: string;
  provider: string;
  rank: number;
};

type RetrievalConfig = {
  enabled: boolean;
  searchProvider: SearchProvider;
  braveApiKey?: string;
  tavilyApiKey?: string;
  serperApiKey?: string;
  searchMaxResults: number;
  fetchMaxPages: number;
  pageMaxChars: number;
  contextMaxChars: number;
  timeoutMs: number;
  browserEngine: BrowserEngine;
  allowDuckDuckGoFallback: boolean;
  allowPrivateUrls: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxLinksPerPage: number;
  maxImagesPerPage: number;
};

type RetrievalOptions = {
  forceSearch?: boolean;
  forceFetch?: boolean;
  searchSettings?: unknown;
  onStatus?: (message: string) => void;
};

type PageFetchResult = {
  url: string;
  finalUrl: string;
  status?: number;
  contentType?: string;
  html?: string;
  fetchedAt: string;
};

let playwrightAvailableCache: boolean | undefined;

function isPackageAvailable(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function isPlaywrightAvailable(): boolean {
  playwrightAvailableCache ??= isPackageAvailable("playwright");
  return playwrightAvailableCache;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, parsed)));
}

function normalizeChoice<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[]
): T {
  if (typeof value === "string" && allowed.includes(value.trim() as T)) {
    return value.trim() as T;
  }

  return fallback;
}

function normalizeDomainList(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const domains = value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  return domains.length ? domains : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getProviderApiKeys(
  provider: SearchProvider,
  apiKeySource: ApiKeySource,
  apiKey: string
): Pick<RetrievalConfig, "braveApiKey" | "tavilyApiKey" | "serperApiKey"> {
  if (apiKeySource === "manual") {
    return {
      braveApiKey: provider === "brave" ? apiKey : undefined,
      tavilyApiKey: provider === "tavily" ? apiKey : undefined,
      serperApiKey: provider === "serper" ? apiKey : undefined
    };
  }

  return {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim(),
    tavilyApiKey: process.env.TAVILY_API_KEY?.trim(),
    serperApiKey: process.env.SERPER_API_KEY?.trim()
  };
}

function getRetrievalConfig(settingsInput?: unknown): RetrievalConfig {
  const settings =
    typeof settingsInput === "object" && settingsInput !== null
      ? (settingsInput as Record<string, unknown>)
      : {};
  const searchProvider = normalizeChoice(
    settings.provider,
    normalizeChoice(
      process.env.STREAMUI_SEARCH_PROVIDER,
      DEFAULT_SEARCH_PROVIDER,
      ["auto", "brave", "tavily", "serper", "duckduckgo", "none"] as const
    ),
    ["auto", "brave", "tavily", "serper", "duckduckgo", "none"] as const
  );
  const apiKeySource = normalizeChoice(
    settings.apiKeySource,
    "environment",
    ["environment", "manual"] as const
  );
  const effectiveApiKeySource =
    searchProvider === "brave" ||
    searchProvider === "tavily" ||
    searchProvider === "serper"
      ? apiKeySource
      : "environment";
  const providerApiKeys = getProviderApiKeys(
    searchProvider,
    effectiveApiKeySource,
    stringValue(settings.apiKey)
  );

  return {
    enabled: normalizeBoolean(
      settings.enabled,
      normalizeBoolean(process.env.STREAMUI_RETRIEVAL, DEFAULT_RETRIEVAL_ENABLED)
    ),
    searchProvider,
    ...providerApiKeys,
    searchMaxResults: clampInteger(
      settings.maxResults,
      clampInteger(
        process.env.STREAMUI_SEARCH_MAX_RESULTS,
        DEFAULT_SEARCH_MAX_RESULTS,
        1,
        10
      ),
      1,
      10
    ),
    fetchMaxPages: clampInteger(
      settings.fetchMaxPages,
      clampInteger(
        process.env.STREAMUI_RETRIEVAL_MAX_PAGES,
        DEFAULT_FETCH_MAX_PAGES,
        0,
        10
      ),
      0,
      10
    ),
    pageMaxChars: clampInteger(
      process.env.STREAMUI_PAGE_MAX_CHARS,
      DEFAULT_PAGE_MAX_CHARS,
      1_000,
      60_000
    ),
    contextMaxChars: clampInteger(
      process.env.STREAMUI_RETRIEVAL_CONTEXT_MAX_CHARS,
      DEFAULT_CONTEXT_MAX_CHARS,
      4_000,
      100_000
    ),
    timeoutMs: clampInteger(
      process.env.STREAMUI_RETRIEVAL_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      2_000,
      45_000
    ),
    browserEngine: normalizeChoice(
      settings.browserEngine,
      normalizeChoice(
        process.env.STREAMUI_BROWSER_ENGINE,
        DEFAULT_BROWSER_ENGINE,
        ["fetch", "playwright"] as const
      ),
      ["fetch", "playwright"] as const
    ),
    allowDuckDuckGoFallback: normalizeBoolean(
      settings.allowDuckDuckGoFallback,
      normalizeBoolean(
        process.env.STREAMUI_SEARCH_ALLOW_DUCKDUCKGO,
        DEFAULT_ALLOW_DUCKDUCKGO_FALLBACK
      )
    ),
    allowPrivateUrls: normalizeBoolean(
      process.env.STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS,
      DEFAULT_ALLOW_PRIVATE_URLS
    ),
    allowedDomains: normalizeDomainList(
      process.env.STREAMUI_RETRIEVAL_ALLOWED_DOMAINS
    ),
    blockedDomains: normalizeDomainList(
      process.env.STREAMUI_RETRIEVAL_BLOCKED_DOMAINS
    ),
    maxLinksPerPage: DEFAULT_MAX_LINKS_PER_PAGE,
    maxImagesPerPage: DEFAULT_MAX_IMAGES_PER_PAGE
  };
}

function clip(value: string | undefined, maxChars: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseAbsoluteUrl(value: string, baseUrl?: string): string | undefined {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function getHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isDomainPermitted(url: string, config: RetrievalConfig): boolean {
  const hostname = getHostname(url);
  if (!hostname) {
    return false;
  }

  if (
    config.blockedDomains?.some((domain) => matchesDomain(hostname, domain))
  ) {
    return false;
  }

  if (
    config.allowedDomains &&
    !config.allowedDomains.some((domain) => matchesDomain(hostname, domain))
  ) {
    return false;
  }

  return true;
}

function extractUrls(text: string): string[] {
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

function removeUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s<>"'`)\]}]+|\bwww\.[^\s<>"'`)\]}]+/gi, " ");
}

function asksForVisualResources(text: string): boolean {
  return /\b(gallery|galleries|gallary|image|images|photo|photos|picture|pictures|pic|pics|screenshot|screenshots|wallpaper|wallpapers|visual reference|visual references|media assets?)\b|图片|照片|图集|图库|相册|壁纸|素材|视觉参考/i.test(
    text
  );
}

function shouldSearch(
  text: string,
  options: RetrievalOptions,
  hasDirectUrls: boolean
): boolean {
  if (options.forceSearch) {
    return true;
  }

  if (hasDirectUrls) {
    const textWithoutUrls = removeUrls(text);
    const urlCompanionCues =
      /\b(search|web|online|current|recent|latest|today|news|find related|related sources|more sources|other sources|references|images|photos|screenshots|assets|examples|alternatives|compare|official)\b|搜索|查一下|查询|最新|今天|现在|新闻|相关|更多来源|其他来源|参考|资料|图片|素材|例子|示例|对比|官网/i;

    return urlCompanionCues.test(textWithoutUrls);
  }

  const cues =
    /\b(current|recent|latest|today|tonight|tomorrow|yesterday|news|search|web|online|source|sources|reference|references|link|links|page|url|site|website|browse|fetch|read|lookup|look up|find|research|official|image|images|photo|photos|picture|pictures|pic|pics|gallery|galleries|gallary|screenshot|screenshots|wallpaper|wallpapers|media assets?|map|maps|weather|price|prices|schedule|release|version)\b|最新|今天|现在|新闻|搜索|查一下|查询|网页|网站|链接|来源|资料|参考|官网|浏览|读取|找|图片|照片|图集|图库|相册|壁纸|素材|地图|价格|日程|版本|发布|当前/i;

  return cues.test(text);
}

function buildSearchQuery(text: string): string {
  const original = clip(removeUrls(text), 260) || clip(text, 260) || "";
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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function buildSearchQueries(text: string): string[] {
  const query = buildSearchQuery(text);
  if (!query) {
    return [];
  }

  if (!asksForVisualResources(text)) {
    return [query];
  }

  return uniqueStrings([
    query,
    `${query} Wikimedia Commons`,
    `${query} site:commons.wikimedia.org`
  ]).slice(0, 3);
}

function privateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function privateIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return privateIpv4(ip);
  }
  if (version === 6) {
    return privateIpv6(ip);
  }
  return true;
}

async function assertPublicUrl(
  url: string,
  config: RetrievalConfig
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs can be retrieved.");
  }

  if (!isDomainPermitted(url, config)) {
    throw new Error("URL is blocked by retrieval domain controls.");
  }

  if (config.allowPrivateUrls) {
    return;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private and local URLs are disabled for retrieval.");
  }

  if (isIP(hostname)) {
    if (privateIpAddress(hostname)) {
      throw new Error("Private and local URLs are disabled for retrieval.");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.some((address) => privateIpAddress(address.address))) {
    throw new Error("Private and local URLs are disabled for retrieval.");
  }
}

function isLikelyHtml(contentType: string | undefined): boolean {
  if (!contentType) {
    return true;
  }

  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    contentType.includes("text/plain")
  );
}

async function readResponseBody(response: globalThis.Response, maxBytes: number) {
  const body = response.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      break;
    }

    const remaining = maxBytes - received;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    received += chunk.byteLength;
    text += decoder.decode(chunk, { stream: received < maxBytes });

    if (value.byteLength > remaining) {
      await reader.cancel();
      text += decoder.decode();
      break;
    }
  }

  return text;
}

async function fetchWithNodeFetch(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  await assertPublicUrl(url, config);

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
      "User-Agent": USER_AGENT
    }
  });
  const contentType = response.headers.get("content-type") ?? undefined;
  const finalUrl = response.url || url;

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}.`);
  }

  if (!isLikelyHtml(contentType)) {
    return {
      url,
      finalUrl,
      status: response.status,
      contentType,
      fetchedAt: new Date().toISOString()
    };
  }

  return {
    url,
    finalUrl,
    status: response.status,
    contentType,
    html: await readResponseBody(response, config.pageMaxChars * 8),
    fetchedAt: new Date().toISOString()
  };
}

async function fetchWithPlaywright(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  await assertPublicUrl(url, config);

  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<any>;
  const playwright = await dynamicImport("playwright");
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 }
    });
    page.setDefaultNavigationTimeout(config.timeoutMs);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs
    });
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(3_000, config.timeoutMs)
      })
      .catch(() => undefined);

    const html = await page.content();
    const headers = response?.headers() ?? {};

    return {
      url,
      finalUrl: page.url() || url,
      status: response?.status(),
      contentType: headers["content-type"],
      html: html.slice(0, config.pageMaxChars * 8),
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

async function fetchPage(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  if (config.browserEngine === "playwright") {
    return isPlaywrightAvailable()
      ? fetchWithPlaywright(url, config)
      : fetchWithNodeFetch(url, config);
  }

  return fetchWithNodeFetch(url, config);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const key = item.url.replace(/\/$/, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function compactParts(values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => clip(value, 220))
    .filter((value): value is string => Boolean(value));

  return parts.length ? parts.join(" · ") : undefined;
}

function imageFromSearchResult(
  result: SearchResult | undefined
): RetrievedImage | undefined {
  if (!result?.imageUrl) {
    return undefined;
  }

  return {
    url: result.imageUrl,
    alt: result.imageAlt || result.title,
    width: result.imageWidth,
    height: result.imageHeight,
    creator: result.imageCreator,
    credit: result.imageCredit,
    license: result.imageLicense,
    licenseUrl: result.imageLicenseUrl
  };
}

function parseSrcset(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function parseHtmlSource(
  page: PageFetchResult,
  config: RetrievalConfig,
  seed?: SearchResult
): RetrievalSource {
  if (!page.html) {
    return {
      id: 0,
      kind: "page",
      url: page.url,
      finalUrl: page.finalUrl,
      title: seed?.title,
      snippet: seed?.snippet,
      provider: seed?.provider,
      searchRank: seed?.rank,
      status: page.status,
      contentType: page.contentType,
      fetchedAt: page.fetchedAt,
      images: imageFromSearchResult(seed) ? [imageFromSearchResult(seed)!] : [],
      links: []
    };
  }

  const $ = load(page.html);
  $("script, style, noscript, template, svg, canvas").remove();

  const title =
    clip($("meta[property='og:title']").attr("content"), 220) ||
    clip($("title").first().text(), 220) ||
    seed?.title;
  const description =
    clip($("meta[name='description']").attr("content"), 420) ||
    clip($("meta[property='og:description']").attr("content"), 420) ||
    seed?.snippet;
  const siteName = clip($("meta[property='og:site_name']").attr("content"), 120);

  const textParts: string[] = [];
  const main = $("article, main, [role='main']").first();
  const root = main.length ? main : $("body");
  root.find("h1,h2,h3,h4,p,li,blockquote,figcaption,th,td").each((_, el) => {
    const text = clip($(el).text(), 900);
    if (text && !textParts.includes(text)) {
      textParts.push(text);
    }
  });

  let text = normalizeWhitespace(textParts.join("\n\n"));
  if (!text) {
    text = normalizeWhitespace($("body").text());
  }

  const links: RetrievedLink[] = [];
  $("a[href]").each((_, el) => {
    const url = parseAbsoluteUrl($(el).attr("href") ?? "", page.finalUrl);
    if (!url || !isDomainPermitted(url, config)) {
      return;
    }

    links.push({
      url,
      text: clip($(el).text(), 140)
    });
  });

  const images: RetrievedImage[] = [];
  const seedImage = imageFromSearchResult(seed);
  const pushImage = (rawUrl: string | undefined, alt?: string) => {
    if (!rawUrl) {
      return;
    }

    const url = parseAbsoluteUrl(rawUrl, page.finalUrl);
    if (!url || !isDomainPermitted(url, config)) {
      return;
    }

    images.push({
      url,
      alt: clip(alt, 160)
    });
  };

  pushImage($("meta[property='og:image']").attr("content"), title);
  if (seedImage) {
    images.push(seedImage);
  }
  $("img[src], img[data-src]").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    const imageUrl = parseAbsoluteUrl(src ?? "", page.finalUrl);
    if (!imageUrl || !isDomainPermitted(imageUrl, config)) {
      return;
    }

    images.push({
      url: imageUrl,
      alt: clip($(el).attr("alt"), 160),
      width: parseNumber($(el).attr("width")),
      height: parseNumber($(el).attr("height"))
    });
  });
  $("source[srcset], img[srcset]").each((_, el) => {
    for (const src of parseSrcset($(el).attr("srcset") ?? "")) {
      pushImage(src, $(el).attr("alt"));
    }
  });

  return {
    id: 0,
    kind: "page",
    url: page.url,
    finalUrl: page.finalUrl,
    title,
    snippet: description,
    text: clip(text, config.pageMaxChars),
    siteName,
    provider: seed?.provider,
    searchRank: seed?.rank,
    status: page.status,
    contentType: page.contentType,
    fetchedAt: page.fetchedAt,
    images: seedImage
      ? [seedImage]
      : uniqueByUrl(images).slice(0, config.maxImagesPerPage),
    links: uniqueByUrl(links).slice(0, config.maxLinksPerPage)
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Search API returned HTTP ${response.status}.`);
  }

  return response.json();
}

async function searchBrave(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = config.braveApiKey;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not set.");
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(config.searchMaxResults));
  url.searchParams.set("text_decorations", "false");

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    web?: {
      results?: Array<{
        url?: string;
        title?: string;
        description?: string;
        thumbnail?: { src?: string };
      }>;
    };
  };

  return (data.web?.results ?? [])
    .map((result, index) => ({
      url: parseAbsoluteUrl(result.url ?? "") ?? "",
      title: clip(result.title, 220),
      snippet: clip(result.description, 420),
      imageUrl: parseAbsoluteUrl(result.thumbnail?.src ?? ""),
      provider: "brave",
      rank: index + 1
    }))
    .filter((result) => result.url);
}

async function searchTavily(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = config.tavilyApiKey;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set.");
  }

  const data = (await fetchJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: config.searchMaxResults,
        include_answer: false,
        include_raw_content: false
      })
    },
    config.timeoutMs
  )) as {
    results?: Array<{
      url?: string;
      title?: string;
      content?: string;
    }>;
  };

  return (data.results ?? [])
    .map((result, index) => ({
      url: parseAbsoluteUrl(result.url ?? "") ?? "",
      title: clip(result.title, 220),
      snippet: clip(result.content, 420),
      provider: "tavily",
      rank: index + 1
    }))
    .filter((result) => result.url);
}

async function searchSerper(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = config.serperApiKey;
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not set.");
  }

  const data = (await fetchJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({
        q: query,
        num: config.searchMaxResults
      })
    },
    config.timeoutMs
  )) as {
    organic?: Array<{
      link?: string;
      title?: string;
      snippet?: string;
      imageUrl?: string;
    }>;
  };

  return (data.organic ?? [])
    .map((result, index) => ({
      url: parseAbsoluteUrl(result.link ?? "") ?? "",
      title: clip(result.title, 220),
      snippet: clip(result.snippet, 420),
      imageUrl: parseAbsoluteUrl(result.imageUrl ?? ""),
      provider: "serper",
      rank: index + 1
    }))
    .filter((result) => result.url);
}

function parseDuckDuckGoRedirect(value: string): string | undefined {
  const absolute = parseAbsoluteUrl(value, "https://duckduckgo.com");
  if (!absolute) {
    return undefined;
  }

  const parsed = new URL(absolute);
  const redirected = parsed.searchParams.get("uddg");
  return parseAbsoluteUrl(redirected || absolute);
}

function isDuckDuckGoChallenge(html: string, status: number): boolean {
  return (
    status === 202 ||
    /anomaly\.js|challenge-form|img-form|captcha/i.test(html)
  );
}

async function searchDuckDuckGo(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT
    }
  });

  const html = await readResponseBody(response, 700_000);
  if (!response.ok || isDuckDuckGoChallenge(html, response.status)) {
    throw new Error(
      response.status === 202 || isDuckDuckGoChallenge(html, response.status)
        ? "DuckDuckGo returned an anomaly challenge instead of search results."
        : `DuckDuckGo returned HTTP ${response.status}.`
    );
  }

  const $ = load(html);
  const results: SearchResult[] = [];

  $(".result, .web-result").each((_, el) => {
    if (results.length >= config.searchMaxResults) {
      return;
    }

    const link = $(el).find(".result__a, a.result__url, a").first();
    const url = parseDuckDuckGoRedirect(link.attr("href") ?? "");
    if (!url) {
      return;
    }

    results.push({
      url,
      title: clip(link.text(), 220),
      snippet: clip($(el).find(".result__snippet").text(), 420),
      provider: "duckduckgo",
      rank: results.length + 1
    });
  });

  if (!results.length && isDuckDuckGoChallenge(html, response.status)) {
    throw new Error(
      "DuckDuckGo returned an anomaly challenge instead of search results."
    );
  }

  return results;
}

function imageProviderLimit(config: RetrievalConfig): number {
  return Math.min(12, Math.max(4, config.searchMaxResults));
}

function cleanImageProviderQuery(query: string): string {
  return (
    clip(
      query
        .replace(/\bsite:\S+/gi, " ")
        .replace(/\b(?:wikimedia commons|openverse|pexels|unsplash)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
      220
    ) || query
  );
}

async function searchOpenverseImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(imageProviderLimit(config)));
  url.searchParams.set("mature", "false");

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    results?: Array<{
      title?: string;
      foreign_landing_url?: string;
      url?: string;
      thumbnail?: string;
      creator?: string;
      creator_url?: string;
      license?: string;
      license_version?: string;
      license_url?: string;
      provider?: string;
      source?: string;
      width?: number;
      height?: number;
    }>;
  };

  return (data.results ?? [])
    .map((result, index) => {
      const license = compactParts([result.license, result.license_version]);
      return {
        url: parseAbsoluteUrl(result.foreign_landing_url ?? result.url ?? "") ?? "",
        title: clip(result.title, 220),
        snippet: compactParts([
          result.creator ? `Creator: ${result.creator}` : undefined,
          license ? `License: ${license}` : undefined,
          result.source || result.provider
        ]),
        imageUrl: parseAbsoluteUrl(result.url ?? result.thumbnail ?? ""),
        imageAlt: clip(result.title, 160),
        imageWidth: result.width,
        imageHeight: result.height,
        imageCreator: clip(result.creator, 160),
        imageCredit: compactParts([result.creator, result.source || result.provider]),
        imageLicense: license,
        imageLicenseUrl: parseAbsoluteUrl(result.license_url ?? ""),
        provider: "openverse",
        rank: index + 1
      };
    })
    .filter((result) => result.url && result.imageUrl);
}

async function searchPexelsImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = process.env.PEXELS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not set.");
  }

  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(imageProviderLimit(config)));

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        Authorization: apiKey,
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    photos?: Array<{
      url?: string;
      width?: number;
      height?: number;
      alt?: string;
      photographer?: string;
      photographer_url?: string;
      src?: {
        original?: string;
        large2x?: string;
        large?: string;
        medium?: string;
      };
    }>;
  };

  return (data.photos ?? [])
    .map((photo, index) => ({
      url: parseAbsoluteUrl(photo.url ?? "") ?? "",
      title: clip(photo.alt || `Pexels photo by ${photo.photographer ?? "unknown"}`, 220),
      snippet: compactParts([
        photo.photographer ? `Photographer: ${photo.photographer}` : undefined,
        "Pexels license"
      ]),
      imageUrl: parseAbsoluteUrl(
        photo.src?.large2x ?? photo.src?.large ?? photo.src?.original ?? photo.src?.medium ?? ""
      ),
      imageAlt: clip(photo.alt, 160),
      imageWidth: photo.width,
      imageHeight: photo.height,
      imageCreator: clip(photo.photographer, 160),
      imageCredit: photo.photographer ? `Photo by ${photo.photographer} on Pexels` : "Pexels",
      imageLicense: "Pexels license",
      imageLicenseUrl: "https://www.pexels.com/license/",
      provider: "pexels",
      rank: index + 1
    }))
    .filter((result) => result.url && result.imageUrl);
}

async function searchUnsplashImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!accessKey) {
    throw new Error("UNSPLASH_ACCESS_KEY is not set.");
  }

  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(imageProviderLimit(config)));
  url.searchParams.set("content_filter", "high");

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        Authorization: `Client-ID ${accessKey}`,
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    results?: Array<{
      alt_description?: string;
      description?: string;
      width?: number;
      height?: number;
      urls?: {
        regular?: string;
        full?: string;
        raw?: string;
        small?: string;
      };
      links?: {
        html?: string;
      };
      user?: {
        name?: string;
        links?: {
          html?: string;
        };
      };
    }>;
  };

  return (data.results ?? [])
    .map((photo, index) => {
      const title =
        photo.description || photo.alt_description || `Unsplash photo by ${photo.user?.name ?? "unknown"}`;
      return {
        url: parseAbsoluteUrl(photo.links?.html ?? "") ?? "",
        title: clip(title, 220),
        snippet: compactParts([
          photo.user?.name ? `Photographer: ${photo.user.name}` : undefined,
          "Unsplash license"
        ]),
        imageUrl: parseAbsoluteUrl(
          photo.urls?.regular ?? photo.urls?.full ?? photo.urls?.small ?? photo.urls?.raw ?? ""
        ),
        imageAlt: clip(photo.alt_description || photo.description, 160),
        imageWidth: photo.width,
        imageHeight: photo.height,
        imageCreator: clip(photo.user?.name, 160),
        imageCredit: photo.user?.name ? `Photo by ${photo.user.name} on Unsplash` : "Unsplash",
        imageLicense: "Unsplash license",
        imageLicenseUrl: "https://unsplash.com/license",
        provider: "unsplash",
        rank: index + 1
      };
    })
    .filter((result) => result.url && result.imageUrl);
}

async function searchNasaImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://images-api.nasa.gov/search");
  url.searchParams.set("q", query);
  url.searchParams.set("media_type", "image");
  url.searchParams.set("page_size", String(imageProviderLimit(config)));

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    collection?: {
      items?: Array<{
        data?: Array<{
          title?: string;
          description?: string;
          nasa_id?: string;
        }>;
        links?: Array<{
          href?: string;
          rel?: string;
          render?: string;
        }>;
      }>;
    };
  };

  return (data.collection?.items ?? [])
    .map((item, index) => {
      const metadata = item.data?.[0] ?? {};
      const preview =
        item.links?.find((link) => link.rel === "preview" || link.render === "image")
          ?.href ?? item.links?.[0]?.href;
      const sourceUrl = metadata.nasa_id
        ? `https://images.nasa.gov/details/${encodeURIComponent(metadata.nasa_id)}`
        : "https://images.nasa.gov/";

      return {
        url: sourceUrl,
        title: clip(metadata.title, 220),
        snippet: compactParts([clip(metadata.description, 320), "NASA Image and Video Library"]),
        imageUrl: parseAbsoluteUrl(preview ?? ""),
        imageAlt: clip(metadata.title, 160),
        imageCredit: "NASA Image and Video Library",
        imageLicense: "NASA media guidelines",
        imageLicenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
        provider: "nasa",
        rank: index + 1
      };
    })
    .filter((result) => result.url && result.imageUrl);
}

async function searchLibraryOfCongressImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://www.loc.gov/photos/");
  url.searchParams.set("fo", "json");
  url.searchParams.set("q", query);
  url.searchParams.set("c", String(imageProviderLimit(config)));

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string | string[];
      contributor_names?: string[];
      image_url?: string[];
    }>;
  };

  return (data.results ?? [])
    .map((item, index) => {
      const imageUrls = item.image_url ?? [];
      const imageUrl = imageUrls[imageUrls.length - 1] ?? imageUrls[0];
      const description = Array.isArray(item.description)
        ? item.description.join(" ")
        : item.description;

      return {
        url: parseAbsoluteUrl(item.url ?? "") ?? "",
        title: clip(item.title, 220),
        snippet: compactParts([
          clip(description, 320),
          item.contributor_names?.[0] ? `Contributor: ${item.contributor_names[0]}` : undefined,
          "Library of Congress"
        ]),
        imageUrl: parseAbsoluteUrl(imageUrl ?? ""),
        imageAlt: clip(item.title, 160),
        imageCreator: clip(item.contributor_names?.[0], 160),
        imageCredit: "Library of Congress",
        imageLicense: "Library of Congress rights advisory",
        imageLicenseUrl: "https://www.loc.gov/free-to-use/",
        provider: "loc",
        rank: index + 1
      };
    })
    .filter((result) => result.url && result.imageUrl);
}

async function searchMetImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const searchUrl = new URL(
    "https://collectionapi.metmuseum.org/public/collection/v1/search"
  );
  searchUrl.searchParams.set("hasImages", "true");
  searchUrl.searchParams.set("q", query);

  const searchData = (await fetchJson(
    searchUrl.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    objectIDs?: number[];
  };

  const objectIds = (searchData.objectIDs ?? []).slice(0, imageProviderLimit(config));
  const objects = await mapLimited(objectIds, 4, async (objectId) => {
    const objectUrl = `https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`;
    return fetchJson(
      objectUrl,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT
        }
      },
      config.timeoutMs
    ) as Promise<{
      objectID?: number;
      title?: string;
      artistDisplayName?: string;
      objectDate?: string;
      objectURL?: string;
      primaryImage?: string;
      primaryImageSmall?: string;
      isPublicDomain?: boolean;
    }>;
  });

  return objects
    .map((object, index) => ({
      url:
        parseAbsoluteUrl(object.objectURL ?? "") ??
        `https://www.metmuseum.org/art/collection/search/${object.objectID ?? ""}`,
      title: clip(object.title, 220),
      snippet: compactParts([
        object.artistDisplayName ? `Artist: ${object.artistDisplayName}` : undefined,
        object.objectDate,
        object.isPublicDomain ? "Public domain image from The Met Open Access" : "The Met Collection"
      ]),
      imageUrl: parseAbsoluteUrl(object.primaryImageSmall ?? object.primaryImage ?? ""),
      imageAlt: clip(object.title, 160),
      imageCreator: clip(object.artistDisplayName, 160),
      imageCredit: "The Metropolitan Museum of Art",
      imageLicense: object.isPublicDomain ? "Public domain" : "The Met image terms",
      imageLicenseUrl: "https://www.metmuseum.org/hubs/open-access",
      provider: "met",
      rank: index + 1
    }))
    .filter((result) => result.url && result.imageUrl);
}

async function searchArtInstituteImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://api.artic.edu/api/v1/artworks/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(imageProviderLimit(config)));
  url.searchParams.set(
    "fields",
    "id,title,artist_display,date_display,image_id,thumbnail"
  );

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    config?: {
      iiif_url?: string;
    };
    data?: Array<{
      id?: number;
      title?: string;
      artist_display?: string;
      date_display?: string;
      image_id?: string;
      thumbnail?: {
        alt_text?: string;
      };
    }>;
  };

  const iiifBase = data.config?.iiif_url || "https://www.artic.edu/iiif/2";

  return (data.data ?? [])
    .map((artwork, index) => ({
      url: artwork.id ? `https://www.artic.edu/artworks/${artwork.id}` : "",
      title: clip(artwork.title, 220),
      snippet: compactParts([
        artwork.artist_display ? `Artist: ${artwork.artist_display}` : undefined,
        artwork.date_display,
        "Art Institute of Chicago"
      ]),
      imageUrl: artwork.image_id
        ? `${iiifBase}/${encodeURIComponent(artwork.image_id)}/full/843,/0/default.jpg`
        : undefined,
      imageAlt: clip(artwork.thumbnail?.alt_text || artwork.title, 160),
      imageCreator: clip(artwork.artist_display, 160),
      imageCredit: "Art Institute of Chicago",
      imageLicense: "Art Institute of Chicago Open Access",
      imageLicenseUrl: "https://www.artic.edu/open-access/open-access-images",
      provider: "artic",
      rank: index + 1
    }))
    .filter((result) => result.url && result.imageUrl);
}

async function searchRijksmuseumImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey =
    process.env.RIJKSMUSEUM_API_KEY?.trim() || process.env.RIJKS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RIJKSMUSEUM_API_KEY is not set.");
  }

  const url = new URL("https://www.rijksmuseum.nl/api/en/collection");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("imgonly", "True");
  url.searchParams.set("ps", String(imageProviderLimit(config)));

  const data = (await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      }
    },
    config.timeoutMs
  )) as {
    artObjects?: Array<{
      title?: string;
      longTitle?: string;
      principalOrFirstMaker?: string;
      links?: {
        web?: string;
      };
      webImage?: {
        url?: string;
        width?: number;
        height?: number;
      };
    }>;
  };

  return (data.artObjects ?? [])
    .map((object, index) => ({
      url: parseAbsoluteUrl(object.links?.web ?? "") ?? "",
      title: clip(object.title || object.longTitle, 220),
      snippet: compactParts([
        object.principalOrFirstMaker ? `Maker: ${object.principalOrFirstMaker}` : undefined,
        object.longTitle,
        "Rijksmuseum"
      ]),
      imageUrl: parseAbsoluteUrl(object.webImage?.url ?? ""),
      imageAlt: clip(object.longTitle || object.title, 160),
      imageWidth: object.webImage?.width,
      imageHeight: object.webImage?.height,
      imageCreator: clip(object.principalOrFirstMaker, 160),
      imageCredit: "Rijksmuseum",
      imageLicense: "Rijksmuseum collection image terms",
      imageLicenseUrl: "https://data.rijksmuseum.nl/",
      provider: "rijksmuseum",
      rank: index + 1
    }))
    .filter((result) => result.url && result.imageUrl);
}

async function searchImageSources(
  query: string,
  config: RetrievalConfig,
  notes: string[],
  onStatus?: (message: string) => void
): Promise<SearchResult[]> {
  const cleanQuery = cleanImageProviderQuery(query);
  if (!cleanQuery) {
    return [];
  }

  const providers: Array<{
    name: string;
    envKeys?: string[];
    search: (query: string, config: RetrievalConfig) => Promise<SearchResult[]>;
  }> = [
    { name: "Openverse", search: searchOpenverseImages },
    { name: "Pexels", envKeys: ["PEXELS_API_KEY"], search: searchPexelsImages },
    {
      name: "Unsplash",
      envKeys: ["UNSPLASH_ACCESS_KEY"],
      search: searchUnsplashImages
    },
    { name: "NASA", search: searchNasaImages },
    { name: "Library of Congress", search: searchLibraryOfCongressImages },
    { name: "The Met", search: searchMetImages },
    { name: "Art Institute of Chicago", search: searchArtInstituteImages },
    {
      name: "Rijksmuseum",
      envKeys: ["RIJKSMUSEUM_API_KEY", "RIJKS_API_KEY"],
      search: searchRijksmuseumImages
    }
  ];

  const results: SearchResult[] = [];

  for (const provider of providers) {
    if (
      provider.envKeys &&
      !provider.envKeys.some((key) => Boolean(process.env[key]?.trim()))
    ) {
      notes.push(
        `${provider.name} image search skipped: set ${provider.envKeys.join(" or ")} to enable it.`
      );
      continue;
    }

    try {
      onStatus?.(
        `Retrieving: searching ${provider.name} images for "${cleanQuery}"...`
      );
      const providerResults = await provider.search(cleanQuery, config);
      if (!providerResults.length) {
        notes.push(`${provider.name} returned no image results.`);
      }
      results.push(...providerResults);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`${provider.name} image search failed: ${message}`);
    }
  }

  return uniqueByUrl(
    results.filter((result) => isDomainPermitted(result.url, config))
  ).slice(0, Math.max(32, config.searchMaxResults * 8));
}

async function searchWeb(
  query: string,
  config: RetrievalConfig,
  notes: string[]
): Promise<SearchResult[]> {
  if (!query || config.searchProvider === "none") {
    return [];
  }

  const providers: SearchProvider[] =
    config.searchProvider === "auto"
      ? [
          config.braveApiKey ? "brave" : undefined,
          config.tavilyApiKey ? "tavily" : undefined,
          config.serperApiKey ? "serper" : undefined,
          config.allowDuckDuckGoFallback ? "duckduckgo" : undefined
        ].filter((provider): provider is SearchProvider => Boolean(provider))
      : [config.searchProvider];

  if (!providers.length) {
    notes.push(
      "No search provider is currently available: no Brave, Tavily, or Serper environment key is configured and DuckDuckGo fallback is disabled."
    );
    return [];
  }

  for (const provider of providers) {
    try {
      const results =
        provider === "brave"
          ? await searchBrave(query, config)
          : provider === "tavily"
            ? await searchTavily(query, config)
            : provider === "serper"
              ? await searchSerper(query, config)
              : provider === "duckduckgo"
                ? await searchDuckDuckGo(query, config)
                : [];

      const permitted = results.filter((result) =>
        isDomainPermitted(result.url, config)
      );
      if (permitted.length) {
        return permitted.slice(0, config.searchMaxResults);
      }

      notes.push(`${provider} returned no permitted search results.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`${provider} search failed: ${message}`);
    }
  }

  return [];
}

function toSearchSource(result: SearchResult): RetrievalSource {
  return {
    id: 0,
    kind: "search-result",
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    provider: result.provider,
    searchRank: result.rank,
    images: imageFromSearchResult(result) ? [imageFromSearchResult(result)!] : [],
    links: []
  };
}

function latestUserText(messages: RetrievalMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) {
      return message.content.trim();
    }
  }

  return "";
}

function assignSourceIds(sources: RetrievalSource[]): RetrievalSource[] {
  return sources.map((source, index) => ({
    ...source,
    id: index + 1
  }));
}

function sourceKey(url: string): string {
  return url.replace(/\/$/, "");
}

function visualResultScore(result: SearchResult): number {
  const hostname = getHostname(result.url) ?? "";
  const haystack = decodeSearchText(
    `${result.url} ${result.title ?? ""} ${result.snippet ?? ""} ${result.provider}`
  );
  let score = 0;

  if (
    [
      "openverse",
      "pexels",
      "unsplash",
      "nasa",
      "loc",
      "met",
      "artic",
      "rijksmuseum"
    ].includes(result.provider)
  ) {
    score += 90;
  } else if (matchesDomain(hostname, "commons.wikimedia.org")) {
    score += 80;
  } else if (matchesDomain(hostname, "wikimedia.org")) {
    score += 60;
  } else if (matchesDomain(hostname, "wikipedia.org")) {
    score += 35;
  } else if (
    matchesDomain(hostname, "openverse.org") ||
    matchesDomain(hostname, "pexels.com") ||
    matchesDomain(hostname, "unsplash.com") ||
    matchesDomain(hostname, "nasa.gov") ||
    matchesDomain(hostname, "loc.gov") ||
    matchesDomain(hostname, "metmuseum.org") ||
    matchesDomain(hostname, "artic.edu") ||
    matchesDomain(hostname, "rijksmuseum.nl")
  ) {
    score += 70;
  } else if (matchesDomain(hostname, "flickr.com")) {
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

function prioritizeSearchResults(
  results: SearchResult[],
  text: string
): SearchResult[] {
  if (!asksForVisualResources(text)) {
    return results;
  }

  return [...results].sort(
    (a, b) => visualResultScore(b) - visualResultScore(a) || a.rank - b.rank
  );
}

async function fetchSources(
  urls: string[],
  searchResults: SearchResult[],
  config: RetrievalConfig,
  onStatus?: (message: string) => void
): Promise<RetrievalSource[]> {
  const seeds = new Map(searchResults.map((result) => [sourceKey(result.url), result]));
  const targets = uniqueByUrl(
    urls
      .map((url) => ({ url }))
      .filter((target) => isDomainPermitted(target.url, config))
  ).slice(0, config.fetchMaxPages);

  const fetched = await Promise.all(
    targets.map(async ({ url }) => {
      const hostname = getHostname(url) ?? url;
      onStatus?.(`Browsing: fetching ${hostname}...`);

      try {
        const page = await fetchPage(url, config);
        return parseHtmlSource(page, config, seeds.get(sourceKey(url)));
      } catch (error) {
        return {
          id: 0,
          kind: "page" as const,
          url,
          title: seeds.get(sourceKey(url))?.title,
          snippet: seeds.get(sourceKey(url))?.snippet,
          provider: seeds.get(sourceKey(url))?.provider,
          searchRank: seeds.get(sourceKey(url))?.rank,
          images: imageFromSearchResult(seeds.get(sourceKey(url)))
            ? [imageFromSearchResult(seeds.get(sourceKey(url)))!]
            : [],
          links: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  return fetched;
}

export async function collectRetrievalContext(
  messages: RetrievalMessage[],
  options: RetrievalOptions = {}
): Promise<RetrievalContext> {
  const config = getRetrievalConfig(options.searchSettings);
  const nowIso = new Date().toISOString();
  const text = latestUserText(messages);
  const directUrls = extractUrls(text).filter((url) =>
    isDomainPermitted(url, config)
  );
  const plannedQueries = buildSearchQueries(text);
  const searchNeeded = shouldSearch(text, options, directUrls.length > 0);
  const fetchNeeded = options.forceFetch || directUrls.length > 0;
  const visualSearchNeeded = searchNeeded && asksForVisualResources(text);
  const notes: string[] = [];

  if (
    fetchNeeded &&
    config.browserEngine === "playwright" &&
    !isPlaywrightAvailable()
  ) {
    notes.push(
      "Playwright was selected for page fetching but is not installed; retrieval fell back to Node fetch."
    );
  }

  const base: RetrievalContext = {
    enabled: config.enabled,
    used: false,
    reason: "No external retrieval was needed for this request.",
    nowIso,
    queries: [],
    urls: directUrls,
    sources: [],
    verifiedImages: [],
    notes
  };

  if (!config.enabled) {
    return {
      ...base,
      reason: "STREAMUI_RETRIEVAL is disabled."
    };
  }

  if (!text) {
    return {
      ...base,
      reason: "No user text was available for retrieval planning."
    };
  }

  if (!searchNeeded && !fetchNeeded) {
    return base;
  }

  const queries: string[] = [];
  let searchResults: SearchResult[] = [];
  const searchResultCap =
    Math.max(config.searchMaxResults, config.fetchMaxPages) *
    (visualSearchNeeded ? 8 : 3);
  const prioritizedResultCap =
    Math.max(config.searchMaxResults, config.fetchMaxPages) *
    (visualSearchNeeded ? 6 : 2);

  if (searchNeeded && plannedQueries.length) {
    if (visualSearchNeeded) {
      queries.push(plannedQueries[0]);
      searchResults = uniqueByUrl([
        ...searchResults,
        ...(await searchImageSources(
          plannedQueries[0],
          config,
          notes,
          options.onStatus
        ))
      ]).slice(0, searchResultCap);
    }

    for (const query of plannedQueries) {
      if (!queries.includes(query)) {
        queries.push(query);
      }
      options.onStatus?.(`Retrieving: searching the web for "${query}"...`);
      searchResults = uniqueByUrl([
        ...searchResults,
        ...(await searchWeb(query, config, notes))
      ]).slice(0, searchResultCap);
    }

    searchResults = prioritizeSearchResults(searchResults, text).slice(
      0,
      prioritizedResultCap
    );
  }

  const searchUrls = searchResults.map((result) => result.url);
  const urlsToFetch = uniqueByUrl(
    [...directUrls, ...searchUrls].map((url) => ({ url }))
  ).map((target) => target.url);
  const pageSources =
    config.fetchMaxPages > 0
      ? await fetchSources(urlsToFetch, searchResults, config, options.onStatus)
      : [];
  const fetchedKeys = new Set(pageSources.map((source) => sourceKey(source.url)));
  const searchOnlySources = searchResults
    .filter((result) => !fetchedKeys.has(sourceKey(result.url)))
    .map(toSearchSource);
  let sources = assignSourceIds([...pageSources, ...searchOnlySources]);
  let verifiedImages: VerifiedImage[] = [];
  if (asksForVisualResources(text)) {
    verifiedImages = await verifyImageCandidates(
      sources,
      queries,
      config,
      notes,
      options.onStatus
    );
    sources = sourcesWithVerifiedImages(sources, verifiedImages);
  }

  return {
    enabled: true,
    used: sources.length > 0 || notes.length > 0,
    reason:
      sources.length > 0
        ? "The StreamUI retrieve tool collected external context."
        : "Retrieval ran but did not return usable sources.",
    nowIso,
    searchProvider: searchResults[0]?.provider,
    queries,
    urls: urlsToFetch,
    sources,
    verifiedImages,
    notes
  };
}

function formatImages(images: RetrievedImage[]): string[] {
  return images.slice(0, 6).map((image) => {
    const alt = image.alt ? ` (${image.alt})` : "";
    const credit = image.credit ? `, ${image.credit}` : "";
    const license = image.license ? `, ${image.license}` : "";
    return `  - ${image.url}${alt}${credit}${license}`;
  });
}

function formatLinks(links: RetrievedLink[]): string[] {
  return links.slice(0, 8).map((link) => {
    const text = link.text ? ` (${link.text})` : "";
    return `  - ${link.url}${text}`;
  });
}

function decodeSearchText(value: string | undefined): string {
  if (!value) {
    return "";
  }

  try {
    return decodeURIComponent(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

const IMAGE_QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "gallery",
  "gallary",
  "galleries",
  "image",
  "images",
  "of",
  "photo",
  "photos",
  "pic",
  "pics",
  "picture",
  "pictures",
  "the",
  "wallpaper",
  "wallpapers"
]);

function imageQueryTerms(queries: string[]): string[] {
  const terms = new Set<string>();
  for (const query of queries) {
    for (const term of decodeSearchText(query).match(/[a-z0-9]+/g) ?? []) {
      if (term.length > 2 && !IMAGE_QUERY_STOP_WORDS.has(term)) {
        terms.add(term);
      }
    }
  }

  return [...terms];
}

function isDecorativeImage(image: RetrievedImage): boolean {
  const haystack = decodeSearchText(`${image.url} ${image.alt ?? ""}`);
  return (
    /\.(?:svg|ico)(?:[?#]|$)/i.test(image.url) ||
    /\b(?:avatar|badge|blank|button|copyright|creative commons|favicon|icon|licen[cs]e|logo|placeholder|rights reserved|some rights reserved|sprite|wordmark)\b/i.test(
      haystack
    ) ||
    (typeof image.width === "number" &&
      typeof image.height === "number" &&
      image.width < 80 &&
      image.height < 80)
  );
}

function imageDedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = decodeURIComponent(parsed.pathname);

    if (matchesDomain(hostname, "upload.wikimedia.org")) {
      const basename = pathname
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/^\d+px-/i, "")
        .replace(/^\d+!/, "")
        .toLowerCase();

      if (basename) {
        return `${hostname}:${basename}`;
      }
    }

    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

function imageRelevanceScore(
  image: RetrievedImage,
  source: RetrievalSource,
  terms: string[]
): number {
  if (!terms.length) {
    return 0;
  }

  const imageHaystack = [image.url, image.alt].map(decodeSearchText).join(" ");
  const sourceHaystack = [source.title, source.snippet, source.siteName]
    .map(decodeSearchText)
    .join(" ");

  const imageMatches = terms.reduce(
    (score, term) => score + (imageHaystack.includes(term) ? 1 : 0),
    0
  );
  const sourceMatches = terms.reduce(
    (score, term) => score + (sourceHaystack.includes(term) ? 1 : 0),
    0
  );

  return imageMatches * 10 + sourceMatches;
}

type ImageCandidate = {
  image: RetrievedImage;
  source: RetrievalSource;
  order: number;
  score: number;
};

function collectImageCandidates(
  sources: RetrievalSource[],
  queries: string[]
): ImageCandidate[] {
  const seen = new Set<string>();
  const terms = imageQueryTerms(queries);
  const candidates: ImageCandidate[] = [];

  for (const source of sources) {
    for (const image of source.images) {
      if (isDecorativeImage(image)) {
        continue;
      }

      const imageUrl = image.url;
      const key = imageDedupeKey(imageUrl);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      candidates.push({
        image: {
          ...image,
          url: imageUrl
        },
        source,
        order: candidates.length,
        score: imageRelevanceScore(image, source, terms)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);

  return candidates;
}

function formatVerifiedImages(images: VerifiedImage[]): string[] {
  return images.slice(0, 24).map((image) => {
    const alt = image.alt ? ` (${image.alt})` : "";
    const sourceTitle = image.sourceTitle ? `, ${image.sourceTitle}` : "";
    const contentType = image.contentType ? `, ${image.contentType}` : "";
    const credit = image.credit ? `, ${image.credit}` : "";
    const license = image.license ? `, ${image.license}` : "";
    const licenseUrl = image.licenseUrl ? `, license: ${image.licenseUrl}` : "";
    return `  - ${image.url}${alt} [source ${image.sourceId}${sourceTitle}${contentType}${credit}${license}${licenseUrl}]`;
  });
}

const WIKIMEDIA_DISPLAY_IMAGE_WIDTH = 1280;

function wikimediaOriginalImageUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      !matchesDomain(parsed.hostname.toLowerCase(), "upload.wikimedia.org") ||
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
    if (!matchesDomain(parsed.hostname.toLowerCase(), "upload.wikimedia.org")) {
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

function imageUrlVariants(url: string): string[] {
  return uniqueStrings([wikimediaDisplayImageUrl(url) ?? "", url]);
}

function uniqueVerifiedImages(images: VerifiedImage[]): VerifiedImage[] {
  const seen = new Set<string>();
  const unique: VerifiedImage[] = [];

  for (const image of images) {
    const key = imageDedupeKey(image.url);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(image);
  }

  return unique;
}

function responseLooksLikeImage(response: globalThis.Response): {
  ok: boolean;
  contentType?: string;
} {
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    ok: response.ok && Boolean(contentType?.toLowerCase().startsWith("image/")),
    contentType
  };
}

function imageRequestReferer(url: string): string | undefined {
  const hostname = getHostname(url);
  if (!hostname) {
    return undefined;
  }

  if (matchesDomain(hostname, "artic.edu")) {
    return "https://www.artic.edu/";
  }

  return undefined;
}

async function validateImageUrl(
  url: string,
  config: RetrievalConfig
): Promise<{ url: string; contentType?: string } | null> {
  await assertPublicUrl(url, config);

  const headers: Record<string, string> = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "User-Agent": IMAGE_USER_AGENT
  };
  const referer = imageRequestReferer(url);
  if (referer) {
    headers.Referer = referer;
  }
  const timeoutMs = Math.min(config.timeoutMs, 8_000);

  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers
    });
    const result = responseLooksLikeImage(head);
    if (result.ok) {
      return { url: head.url || url, contentType: result.contentType };
    }
  } catch {
    // Some image hosts do not support HEAD. Fall back to a tiny ranged GET.
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...headers,
      Range: "bytes=0-0"
    }
  });
  const result = responseLooksLikeImage(response);
  if (response.body) {
    await response.body.cancel().catch(() => undefined);
  }

  return result.ok
    ? { url: response.url || url, contentType: result.contentType }
    : null;
}

async function mapLimited<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker())
  );

  return results;
}

async function verifyImageCandidates(
  sources: RetrievalSource[],
  queries: string[],
  config: RetrievalConfig,
  notes: string[],
  onStatus?: (message: string) => void
): Promise<VerifiedImage[]> {
  const candidates = collectImageCandidates(sources, queries).slice(0, 56);
  if (!candidates.length) {
    return [];
  }

  onStatus?.(`Retrieving: verifying ${candidates.length} image candidates...`);
  let rejected = 0;
  const verified = await mapLimited<ImageCandidate, VerifiedImage | null>(
    candidates,
    4,
    async (candidate) => {
      for (const variant of imageUrlVariants(candidate.image.url)) {
        try {
          const result = await validateImageUrl(variant, config);
          if (result) {
            return {
              ...candidate.image,
              url: result.url,
              sourceId: candidate.source.id,
              ...(candidate.source.title
                ? { sourceTitle: candidate.source.title }
                : {}),
              sourceUrl: candidate.source.finalUrl || candidate.source.url,
              ...(result.contentType ? { contentType: result.contentType } : {})
            };
          }
        } catch {
          // Try the next variant, then count the candidate as rejected below.
        }
      }

      rejected += 1;
      return null;
    }
  );

  if (rejected) {
    notes.push(`Image verification rejected ${rejected} non-loadable candidate URLs.`);
  }

  return uniqueVerifiedImages(
    verified.filter((image): image is VerifiedImage => image !== null)
  ).slice(0, 18);
}

function sourcesWithVerifiedImages(
  sources: RetrievalSource[],
  verifiedImages: VerifiedImage[]
): RetrievalSource[] {
  const bySource = new Map<number, RetrievedImage[]>();
  for (const image of verifiedImages) {
    const images = bySource.get(image.sourceId) ?? [];
    images.push({
      url: image.url,
      alt: image.alt,
      width: image.width,
      height: image.height,
      creator: image.creator,
      credit: image.credit,
      license: image.license,
      licenseUrl: image.licenseUrl
    });
    bySource.set(image.sourceId, images);
  }

  return sources.map((source) => ({
    ...source,
    images: bySource.get(source.id) ?? []
  }));
}

export function buildRetrievalContextPrompt(
  context: RetrievalContext,
  settingsInput?: unknown
): string {
  const maxChars = getRetrievalConfig(settingsInput).contextMaxChars;
  const lines: string[] = [
    "Current runtime context:",
    `- Server timestamp: ${context.nowIso}`,
    "- Use this timestamp for current date/time grounding unless the user gives a different date.",
    "",
    "StreamUI retrieve tool result:",
    `- Status: ${context.used ? "ran" : "not run"}`,
    `- Reason: ${context.reason}`
  ];

  if (!context.used) {
    lines.push(
      "- No external web/page context was injected. Do not imply that you browsed the web."
    );
    return lines.join("\n");
  }

  if (context.queries.length) {
    lines.push(`- Search queries: ${context.queries.join(" | ")}`);
  }

  if (context.notes.length) {
    lines.push("- Retrieval notes:");
    for (const note of context.notes.slice(0, 6)) {
      lines.push(`  - ${note}`);
    }
  }

  const verifiedImageLines = formatVerifiedImages(context.verifiedImages);
  if (verifiedImageLines.length) {
    lines.push("");
    lines.push(
      "Verified image URLs for visual/gallery use. The server checked these URLs and received image/* responses. Copy these URLs exactly into <img src>. Do not resize, rewrite, shorten, add px prefixes, remove query strings, or invent variants:"
    );
    lines.push(...verifiedImageLines);
  } else if (context.queries.some((query) => asksForVisualResources(query))) {
    lines.push("");
    lines.push(
      "No verified direct image URLs were available. Do not render broken <img> tags; use source links or explain that verified images were not available."
    );
  }

  lines.push(
    "",
    "Use the following sources only when relevant. When web context influences the answer, include concise source links in the HTML artifact."
  );

  for (const source of context.sources) {
    lines.push("");
    lines.push(`[${source.id}] ${source.title || source.url}`);
    lines.push(`URL: ${source.finalUrl || source.url}`);
    if (source.siteName) {
      lines.push(`Site: ${source.siteName}`);
    }
    if (source.provider || source.searchRank) {
      lines.push(
        `Search: ${source.provider || "unknown"}${
          source.searchRank ? ` rank ${source.searchRank}` : ""
        }`
      );
    }
    if (source.status) {
      lines.push(`HTTP status: ${source.status}`);
    }
    if (source.error) {
      lines.push(`Fetch error: ${source.error}`);
    }
    if (source.snippet) {
      lines.push(`Snippet: ${source.snippet}`);
    }
    if (source.text) {
      lines.push(`Extracted text: ${source.text}`);
    }
    if (source.images.length) {
      lines.push("Images:");
      lines.push(...formatImages(source.images));
    }
    if (source.links.length) {
      lines.push("Page links:");
      lines.push(...formatLinks(source.links));
    }
  }

  const prompt = lines.join("\n");
  if (prompt.length <= maxChars) {
    return prompt;
  }

  return `${prompt.slice(0, maxChars - 80).trimEnd()}\n\n[Retrieval context truncated for prompt size.]`;
}

function normalizeRetrieveBody(body: unknown): RetrievalMessage[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const input = body as {
    query?: unknown;
    url?: unknown;
    messages?: unknown;
  };

  if (Array.isArray(input.messages)) {
    return input.messages
      .filter((message): message is { role?: unknown; content?: unknown } => {
        return Boolean(
          message &&
            typeof message === "object" &&
            typeof (message as { content?: unknown }).content === "string"
        );
      })
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content)
      }));
  }

  const parts = [input.query, input.url]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  return parts.length ? [{ role: "user", content: parts.join("\n") }] : [];
}

export async function handleRetrievalRequest(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const messages = normalizeRetrieveBody(req.body);
    const forceSearch =
      typeof req.body === "object" &&
      req.body !== null &&
      normalizeBoolean((req.body as { forceSearch?: unknown }).forceSearch, false);
    const forceFetch =
      typeof req.body === "object" &&
      req.body !== null &&
      normalizeBoolean((req.body as { forceFetch?: unknown }).forceFetch, false);
    const searchSettings =
      typeof req.body === "object" && req.body !== null
        ? (req.body as { searchSettings?: unknown }).searchSettings
        : undefined;
    const context = await collectRetrievalContext(messages, {
      forceSearch,
      forceFetch,
      searchSettings
    });

    res.json(context);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
