import assert from "node:assert/strict";
import test from "node:test";
import {
  searchRetrievalWeb,
  selectRetrievalWebProviders,
  tavilyQueryOptions,
  type RetrievalWebProviderSearches
} from "./retrievalWebProviders.js";
import type { RetrievalConfig } from "./retrievalTypes.js";

function config(overrides: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return {
    enabled: true,
    searchProvider: "auto",
    searchMaxResults: 5,
    fetchMaxPages: 4,
    pageMaxChars: 10_000,
    contextMaxChars: 32_000,
    timeoutMs: 12_000,
    browserEngine: "fetch",
    allowDuckDuckGoFallback: true,
    allowPrivateUrls: false,
    maxLinksPerPage: 24,
    maxImagesPerPage: 18,
    ...overrides
  };
}

test("auto web provider selection skips providers without keys", () => {
  assert.deepEqual(selectRetrievalWebProviders(config()), ["duckduckgo"]);
  assert.deepEqual(
    selectRetrievalWebProviders(config({ braveApiKey: "key", tavilyApiKey: "key" })),
    ["brave", "tavily", "duckduckgo"]
  );
  assert.deepEqual(
    selectRetrievalWebProviders(config({ allowDuckDuckGoFallback: false })),
    []
  );
});

test("Tavily converts site operators and current visual cues into native filters", () => {
  assert.deepEqual(
    tavilyQueryOptions(
      "North Harbor Festival 2026 site:instagram.com OR site:youtube.com/watch videos",
      2026
    ),
    {
      query: "North Harbor Festival 2026 videos",
      includeDomains: ["instagram.com", "youtube.com"],
      timeRange: "week"
    }
  );
  assert.deepEqual(tavilyQueryOptions("North Harbor Festival archive", 2026), {
    query: "North Harbor Festival archive",
    includeDomains: []
  });
});

test("web search records missing providers when fallback is disabled", async () => {
  const notes: string[] = [];
  assert.deepEqual(
    await searchRetrievalWeb(
      "query",
      config({ allowDuckDuckGoFallback: false }),
      notes
    ),
    []
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /No search provider/);
});

test("web search falls through a failed keyed provider to DuckDuckGo", async () => {
  const calls: string[] = [];
  const searches: RetrievalWebProviderSearches = {
    brave: async () => {
      calls.push("brave");
      throw new Error("temporary outage");
    },
    tavily: async () => [],
    serper: async () => [],
    duckduckgo: async () => {
      calls.push("duckduckgo");
      return [
        {
          url: "https://example.com/result",
          title: "Result",
          provider: "duckduckgo",
          rank: 1
        }
      ];
    }
  };
  const notes: string[] = [];

  const results = await searchRetrievalWeb(
    "query",
    config({ braveApiKey: "key" }),
    notes,
    searches
  );

  assert.deepEqual(calls, ["brave", "duckduckgo"]);
  assert.equal(results[0]?.url, "https://example.com/result");
  assert.deepEqual(notes, ["brave search failed: temporary outage"]);
});
