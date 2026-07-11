import type { Request, Response } from "express";
import { createRequire } from "node:module";
import {
  rethrowIfRetrievalAborted,
  throwIfRetrievalAborted
} from "./retrievalAbort.js";
import {
  fetchRetrievalPageWithNode,
  fetchRetrievalPageWithPlaywright,
  type RetrievalPageFetchResult
} from "./retrievalHttpClient.js";
import {
  getRetrievalHostname as getHostname,
  isRetrievalDomainPermitted as isDomainPermitted
} from "./retrievalUrlPolicy.js";
import {
  asksForVisualResources,
  asksForRecentVisualResources,
  buildRetrievalImageSearchQueries as buildImageSearchQueries,
  buildRetrievalSearchQueries as buildSearchQueries,
  extractRetrievalUrls as extractUrls,
  latestRetrievalUserText as latestUserText,
  prioritizeRetrievalSearchResults as prioritizeSearchResults,
  shouldSearchRetrieval as shouldSearch
} from "./retrievalPlanner.js";
import {
  parseRetrievalHtmlSource as parseHtmlSource,
  shouldRenderSpaFallback
} from "./retrievalHtmlParser.js";
export { shouldRenderSpaFallback } from "./retrievalHtmlParser.js";
import { searchRetrievalWeb as searchWeb } from "./retrievalWebProviders.js";
import { RETRIEVAL_USER_AGENT as USER_AGENT } from "./retrievalProviderClient.js";
import {
  imageFromSearchResult,
  sourceKey,
  uniqueByUrl
} from "./retrievalPrimitives.js";
import {
  formatVerifiedRetrievalImages as formatVerifiedImages,
  sourcesWithVerifiedRetrievalImages as sourcesWithVerifiedImages,
  verifyRetrievalImageCandidates as verifyImageCandidates
} from "./retrievalImageVerification.js";
import {
  createRecentRetrievalImageProviders,
  searchRetrievalImageSources as searchImageSources
} from "./retrievalImageProviders.js";
import type {
  RetrievedImage,
  RetrievedLink,
  RetrievalConfig,
  RetrievalContext,
  RetrievalMessage,
  RetrievalOptions,
  RetrievalSource,
  SearchProvider,
  SearchResult,
  VerifiedImage
} from "./retrievalTypes.js";
export type {
  RetrievedImage,
  RetrievedLink,
  RetrievalContext,
  RetrievalMessage,
  RetrievalSource
} from "./retrievalTypes.js";

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
const require = createRequire(import.meta.url);

type ApiKeySource = "environment" | "manual";

type PageFetchResult = RetrievalPageFetchResult;

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

function getRetrievalConfig(
  settingsInput?: unknown,
  signal?: AbortSignal
): RetrievalConfig {
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
    maxImagesPerPage: DEFAULT_MAX_IMAGES_PER_PAGE,
    signal
  };
}

async function fetchWithNodeFetch(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  return fetchRetrievalPageWithNode(url, config, USER_AGENT);
}

async function fetchWithPlaywright(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  return fetchRetrievalPageWithPlaywright(url, config, USER_AGENT);
}

async function fetchPage(
  url: string,
  config: RetrievalConfig
): Promise<PageFetchResult> {
  if (config.browserEngine === "playwright" && config.allowPrivateUrls) {
    return isPlaywrightAvailable()
      ? fetchWithPlaywright(url, config)
      : fetchWithNodeFetch(url, config);
  }

  return fetchWithNodeFetch(url, config);
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

function assignSourceIds(sources: RetrievalSource[]): RetrievalSource[] {
  return sources.map((source, index) => ({
    ...source,
    id: index + 1
  }));
}

async function fetchSources(
  urls: string[],
  searchResults: SearchResult[],
  config: RetrievalConfig,
  notes: string[],
  onStatus?: (message: string) => void
): Promise<RetrievalSource[]> {
  throwIfRetrievalAborted(config.signal);
  const seeds = new Map(searchResults.map((result) => [sourceKey(result.url), result]));
  const targets = uniqueByUrl(
    urls
      .map((url) => ({ url }))
      .filter((target) => isDomainPermitted(target.url, config))
  ).slice(0, config.fetchMaxPages);

  const fetched = await Promise.all(
    targets.map(async ({ url }) => {
      throwIfRetrievalAborted(config.signal);
      const hostname = getHostname(url) ?? url;
      onStatus?.(`Browsing: fetching ${hostname}...`);

      try {
        const page = await fetchPage(url, config);
        const source = parseHtmlSource(page, config, seeds.get(sourceKey(url)));
        if (
          config.browserEngine === "fetch" &&
          shouldRenderSpaFallback(source)
        ) {
          if (!config.allowPrivateUrls) {
            notes.push(
              `Static fetch for ${hostname} looked like a client-rendered SPA shell; Playwright retry was skipped because private URLs are blocked.`
            );
            return source;
          }
          if (!isPlaywrightAvailable()) {
            notes.push(
              `Static fetch for ${hostname} looked like a client-rendered SPA shell, but Playwright is not installed; only the static shell was returned.`
            );
            return source;
          }

          onStatus?.(`Browsing: rendering ${hostname} with Playwright...`);
          notes.push(
            `Static fetch for ${hostname} returned a likely SPA shell, so ChatHTML automatically retried with Playwright.`
          );
          try {
            return parseHtmlSource(
              await fetchWithPlaywright(url, config),
              config,
              seeds.get(sourceKey(url))
            );
          } catch (fallbackError) {
            rethrowIfRetrievalAborted(fallbackError, config.signal);
            notes.push(
              `Automatic Playwright retry for ${hostname} failed: ${
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError)
              }`
            );
            return source;
          }
        }

        return source;
      } catch (error) {
        rethrowIfRetrievalAborted(error, config.signal);
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
  throwIfRetrievalAborted(options.signal);
  const config = getRetrievalConfig(options.searchSettings, options.signal);
  const nowIso = new Date().toISOString();
  const text = latestUserText(messages);
  const intentText = options.intentText?.trim() || text;
  const directUrls = extractUrls(text).filter((url) =>
    isDomainPermitted(url, config)
  );
  const plannedQueries = buildSearchQueries(text, intentText);
  const plannedImageQueries = buildImageSearchQueries(text, intentText);
  const searchNeeded = shouldSearch(text, options, directUrls.length > 0);
  const fetchNeeded = options.forceFetch || directUrls.length > 0;
  const visualSearchNeeded = searchNeeded && asksForVisualResources(intentText);
  const notes: string[] = [];

  if (
    fetchNeeded &&
    config.browserEngine === "playwright" &&
    (!isPlaywrightAvailable() || !config.allowPrivateUrls)
  ) {
    notes.push(
      !config.allowPrivateUrls
        ? "Playwright page fetching is disabled while private URLs are blocked; retrieval used pinned Node fetch."
        : "Playwright was selected for page fetching but is not installed; retrieval fell back to Node fetch."
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
    throwIfRetrievalAborted(config.signal);
    if (visualSearchNeeded) {
      if (asksForRecentVisualResources(intentText)) {
        notes.push(
          "Recent-event visual search prioritized current web and social sources over archival image catalogs."
        );
        for (const imageQuery of plannedImageQueries) {
          if (!queries.includes(imageQuery)) {
            queries.push(imageQuery);
          }
          searchResults = uniqueByUrl([
            ...searchResults,
            ...(await searchImageSources(
              imageQuery,
              config,
              notes,
              options.onStatus,
              createRecentRetrievalImageProviders()
            ))
          ]).slice(0, searchResultCap);
        }
      } else {
        const imageQuery = plannedImageQueries[0] || plannedQueries[0];
        if (!queries.includes(imageQuery)) {
          queries.push(imageQuery);
        }
        searchResults = uniqueByUrl([
          ...searchResults,
          ...(await searchImageSources(
            imageQuery,
            config,
            notes,
            options.onStatus
          ))
        ]).slice(0, searchResultCap);
      }
    }

    for (const query of plannedQueries) {
      throwIfRetrievalAborted(config.signal);
      if (!queries.includes(query)) {
        queries.push(query);
      }
      options.onStatus?.(`Retrieving: searching the web for "${query}"...`);
      searchResults = uniqueByUrl([
        ...searchResults,
        ...(await searchWeb(query, config, notes))
      ]).slice(0, searchResultCap);
    }

    searchResults = prioritizeSearchResults(
      searchResults,
      intentText,
      plannedQueries[0]
    ).slice(0, prioritizedResultCap);
  }

  const searchUrls = searchResults.map((result) => result.url);
  const urlsToFetch = uniqueByUrl(
    [...directUrls, ...searchUrls].map((url) => ({ url }))
  ).map((target) => target.url);
  const pageSources =
    config.fetchMaxPages > 0
      ? await fetchSources(
          urlsToFetch,
          searchResults,
          config,
          notes,
          options.onStatus
        )
      : [];
  throwIfRetrievalAborted(config.signal);
  const fetchedKeys = new Set(pageSources.map((source) => sourceKey(source.url)));
  const searchOnlySources = searchResults
    .filter((result) => !fetchedKeys.has(sourceKey(result.url)))
    .map(toSearchSource);
  let sources = assignSourceIds([...pageSources, ...searchOnlySources]);
  let verifiedImages: VerifiedImage[] = [];
  if (asksForVisualResources(intentText)) {
    verifiedImages = await verifyImageCandidates(
      sources,
      queries,
      config,
      notes,
      options.onStatus
    );
    sources = sourcesWithVerifiedImages(sources, verifiedImages);
  }
  throwIfRetrievalAborted(config.signal);

  return {
    enabled: true,
    used: sources.length > 0 || notes.length > 0,
    reason:
      sources.length > 0
        ? "The ChatHTML retrieve tool collected external context."
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
    "ChatHTML retrieve tool result:",
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
    lines.push(
      "- Strict image allowlist: every external <img src> in the artifact must exactly match one URL in the verified list above. Source-page URLs, snippets, and model knowledge are not image authorization."
    );
  } else if (context.queries.some((query) => asksForVisualResources(query))) {
    lines.push("");
    lines.push(
      "No verified direct image URLs were available. Do not emit any external <img> element or image URL. Use a complete text-led layout with source links and explain that verified images were not available; do not leave an empty hero or media frame."
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
