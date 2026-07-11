import { load } from "cheerio";
import {
  createRetrievalOperationSignal,
  rethrowIfRetrievalAborted,
  throwIfRetrievalAborted
} from "./retrievalAbort.js";
import { readBoundedResponseBody } from "./retrievalHttpClient.js";
import { clip, parseAbsoluteUrl } from "./retrievalPrimitives.js";
import {
  fetchRetrievalJson,
  RETRIEVAL_USER_AGENT
} from "./retrievalProviderClient.js";
import type {
  RetrievalConfig,
  SearchProvider,
  SearchResult
} from "./retrievalTypes.js";
import { isRetrievalDomainPermitted } from "./retrievalUrlPolicy.js";

export async function searchBrave(
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

  const data = (await fetchRetrievalJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": RETRIEVAL_USER_AGENT
      }
    },
    config.timeoutMs,
    config.signal
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

export async function searchTavily(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = config.tavilyApiKey;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set.");
  }

  const data = (await fetchRetrievalJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": RETRIEVAL_USER_AGENT
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: "general",
        search_depth: "basic",
        max_results: config.searchMaxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    },
    config.timeoutMs,
    config.signal
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

export async function searchSerper(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = config.serperApiKey;
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not set.");
  }

  const data = (await fetchRetrievalJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "User-Agent": RETRIEVAL_USER_AGENT
      },
      body: JSON.stringify({
        q: query,
        num: config.searchMaxResults
      })
    },
    config.timeoutMs,
    config.signal
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

export function parseDuckDuckGoRedirect(value: string): string | undefined {
  const absolute = parseAbsoluteUrl(value, "https://duckduckgo.com");
  if (!absolute) {
    return undefined;
  }

  const parsed = new URL(absolute);
  const redirected = parsed.searchParams.get("uddg");
  return parseAbsoluteUrl(redirected || absolute);
}

function isDuckDuckGoChallenge(html: string, status: number): boolean {
  return status === 202 || /anomaly\.js|challenge-form|img-form|captcha/i.test(html);
}

export async function searchDuckDuckGo(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    signal: createRetrievalOperationSignal(config.timeoutMs, config.signal),
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": RETRIEVAL_USER_AGENT
    }
  });

  const html = await readBoundedResponseBody(response, 700_000);
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
    const resultUrl = parseDuckDuckGoRedirect(link.attr("href") ?? "");
    if (!resultUrl) {
      return;
    }

    results.push({
      url: resultUrl,
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

export type RetrievalWebProviderSearches = Record<
  Exclude<SearchProvider, "auto" | "none">,
  (query: string, config: RetrievalConfig) => Promise<SearchResult[]>
>;

const defaultProviderSearches: RetrievalWebProviderSearches = {
  brave: searchBrave,
  tavily: searchTavily,
  serper: searchSerper,
  duckduckgo: searchDuckDuckGo
};

export function selectRetrievalWebProviders(
  config: RetrievalConfig
): Array<Exclude<SearchProvider, "auto" | "none">> {
  if (config.searchProvider === "none") {
    return [];
  }
  if (config.searchProvider !== "auto") {
    return [config.searchProvider];
  }

  return [
    config.braveApiKey ? "brave" : undefined,
    config.tavilyApiKey ? "tavily" : undefined,
    config.serperApiKey ? "serper" : undefined,
    config.allowDuckDuckGoFallback ? "duckduckgo" : undefined
  ].filter(
    (
      provider
    ): provider is Exclude<SearchProvider, "auto" | "none"> => Boolean(provider)
  );
}

export async function searchRetrievalWeb(
  query: string,
  config: RetrievalConfig,
  notes: string[],
  providerSearches: RetrievalWebProviderSearches = defaultProviderSearches
): Promise<SearchResult[]> {
  throwIfRetrievalAborted(config.signal);
  if (!query || config.searchProvider === "none") {
    return [];
  }

  const providers = selectRetrievalWebProviders(config);
  if (!providers.length) {
    notes.push(
      "No search provider is currently available: no Brave, Tavily, or Serper environment key is configured and DuckDuckGo fallback is disabled."
    );
    return [];
  }

  for (const provider of providers) {
    throwIfRetrievalAborted(config.signal);
    try {
      const results = await providerSearches[provider](query, config);
      const permitted = results.filter((result) =>
        isRetrievalDomainPermitted(result.url, config)
      );
      if (permitted.length) {
        return permitted.slice(0, config.searchMaxResults);
      }

      notes.push(`${provider} returned no permitted search results.`);
    } catch (error) {
      rethrowIfRetrievalAborted(error, config.signal);
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`${provider} search failed: ${message}`);
    }
  }

  return [];
}
