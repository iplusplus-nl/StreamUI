import {
  searchArtInstituteImages,
  searchLibraryOfCongressImages,
  searchMetImages,
  searchNasaImages,
  searchRijksmuseumImages
} from "./retrievalCulturalImageProviders.js";
import {
  rethrowIfRetrievalAborted,
  throwIfRetrievalAborted
} from "./retrievalAbort.js";
import { cleanRetrievalImageProviderQuery } from "./retrievalProviderClient.js";
import { uniqueByUrl } from "./retrievalPrimitives.js";
import {
  searchOpenverseImages,
  searchPexelsImages,
  searchTavilyImages,
  searchUnsplashImages
} from "./retrievalStockImageProviders.js";
import type { RetrievalConfig, SearchResult } from "./retrievalTypes.js";
import { isRetrievalDomainPermitted } from "./retrievalUrlPolicy.js";

export type RetrievalImageProvider = {
  name: string;
  envKeys?: string[];
  configured?: (
    config: RetrievalConfig,
    environment: NodeJS.ProcessEnv
  ) => boolean;
  setupHint?: string;
  search: (query: string, config: RetrievalConfig) => Promise<SearchResult[]>;
};

export function createRecentRetrievalImageProviders(): RetrievalImageProvider[] {
  return [
    {
      name: "Tavily Images",
      configured: (config) => Boolean(config.tavilyApiKey),
      setupHint: "select Tavily with an API key or set TAVILY_API_KEY",
      search: searchTavilyImages
    }
  ];
}

export function createRetrievalImageProviders(): RetrievalImageProvider[] {
  return [
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
}

export async function searchRetrievalImageSources(
  query: string,
  config: RetrievalConfig,
  notes: string[],
  onStatus?: (message: string) => void,
  providers: RetrievalImageProvider[] = createRetrievalImageProviders(),
  environment: NodeJS.ProcessEnv = process.env
): Promise<SearchResult[]> {
  throwIfRetrievalAborted(config.signal);
  const cleanQuery = cleanRetrievalImageProviderQuery(query);
  if (!cleanQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  for (const provider of providers) {
    throwIfRetrievalAborted(config.signal);
    if (
      (provider.configured && !provider.configured(config, environment)) ||
      (provider.envKeys &&
        !provider.envKeys.some((key) => Boolean(environment[key]?.trim())))
    ) {
      notes.push(
        `${provider.name} image search skipped: ${
          provider.setupHint ?? `set ${provider.envKeys?.join(" or ")} to enable it`
        }.`
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
      rethrowIfRetrievalAborted(error, config.signal);
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`${provider.name} image search failed: ${message}`);
    }
  }

  return uniqueByUrl(
    results.filter((result) => isRetrievalDomainPermitted(result.url, config))
  ).slice(0, Math.max(32, config.searchMaxResults * 8));
}
