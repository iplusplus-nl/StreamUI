import {
  clip,
  compactParts,
  parseAbsoluteUrl
} from "./retrievalPrimitives.js";
import {
  fetchRetrievalJson,
  retrievalImageProviderLimit,
  RETRIEVAL_USER_AGENT
} from "./retrievalProviderClient.js";
import type { RetrievalConfig, SearchResult } from "./retrievalTypes.js";

export async function searchTavilyImages(
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
        max_results: Math.min(5, retrievalImageProviderLimit(config)),
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true
      })
    },
    config.timeoutMs,
    config.signal
  )) as {
    images?: Array<string | { url?: string; description?: string }>;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      images?: Array<string | { url?: string; description?: string }>;
    }>;
  };

  const results: SearchResult[] = [];
  const addImage = (
    image: string | { url?: string; description?: string },
    sourceUrl: string,
    sourceTitle: string | undefined,
    sourceContent: string | undefined
  ) => {
    const rawImageUrl = typeof image === "string" ? image : image.url ?? "";
    const imageUrl = parseAbsoluteUrl(rawImageUrl);
    const landingUrl = parseAbsoluteUrl(sourceUrl) ?? imageUrl;
    if (!imageUrl || !landingUrl) {
      return;
    }
    const description = typeof image === "string" ? undefined : image.description;
    results.push({
      url: landingUrl,
      title: clip(sourceTitle || description, 220),
      snippet: clip(description || sourceContent, 420),
      imageUrl,
      imageAlt: clip(description || sourceTitle, 160),
      imageCredit: "Tavily image search",
      provider: "tavily-images",
      rank: results.length + 1
    });
  };

  for (const result of data.results ?? []) {
    for (const image of result.images ?? []) {
      addImage(image, result.url ?? "", result.title, result.content);
    }
  }
  if (!results.length) {
    for (const image of data.images ?? []) {
      addImage(image, "", undefined, undefined);
    }
  }

  return results
    .filter((result) => result.url && result.imageUrl);
}

export async function searchOpenverseImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(retrievalImageProviderLimit(config)));
  url.searchParams.set("mature", "false");

  const data = (await fetchRetrievalJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": RETRIEVAL_USER_AGENT
      }
    },
    config.timeoutMs,
    config.signal
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

export async function searchPexelsImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const apiKey = process.env.PEXELS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not set.");
  }

  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(retrievalImageProviderLimit(config)));

  const data = (await fetchRetrievalJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        Authorization: apiKey,
        "User-Agent": RETRIEVAL_USER_AGENT
      }
    },
    config.timeoutMs,
    config.signal
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
      title: clip(
        photo.alt || `Pexels photo by ${photo.photographer ?? "unknown"}`,
        220
      ),
      snippet: compactParts([
        photo.photographer ? `Photographer: ${photo.photographer}` : undefined,
        "Pexels license"
      ]),
      imageUrl: parseAbsoluteUrl(
        photo.src?.large2x ??
          photo.src?.large ??
          photo.src?.original ??
          photo.src?.medium ??
          ""
      ),
      imageAlt: clip(photo.alt, 160),
      imageWidth: photo.width,
      imageHeight: photo.height,
      imageCreator: clip(photo.photographer, 160),
      imageCredit: photo.photographer
        ? `Photo by ${photo.photographer} on Pexels`
        : "Pexels",
      imageLicense: "Pexels license",
      imageLicenseUrl: "https://www.pexels.com/license/",
      provider: "pexels",
      rank: index + 1
    }))
    .filter((result) => result.url && result.imageUrl);
}

export async function searchUnsplashImages(
  query: string,
  config: RetrievalConfig
): Promise<SearchResult[]> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!accessKey) {
    throw new Error("UNSPLASH_ACCESS_KEY is not set.");
  }

  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(retrievalImageProviderLimit(config)));
  url.searchParams.set("content_filter", "high");

  const data = (await fetchRetrievalJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        Authorization: `Client-ID ${accessKey}`,
        "User-Agent": RETRIEVAL_USER_AGENT
      }
    },
    config.timeoutMs,
    config.signal
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
      links?: { html?: string };
      user?: { name?: string; links?: { html?: string } };
    }>;
  };

  return (data.results ?? [])
    .map((photo, index) => {
      const title =
        photo.description ||
        photo.alt_description ||
        `Unsplash photo by ${photo.user?.name ?? "unknown"}`;
      return {
        url: parseAbsoluteUrl(photo.links?.html ?? "") ?? "",
        title: clip(title, 220),
        snippet: compactParts([
          photo.user?.name ? `Photographer: ${photo.user.name}` : undefined,
          "Unsplash license"
        ]),
        imageUrl: parseAbsoluteUrl(
          photo.urls?.regular ??
            photo.urls?.full ??
            photo.urls?.small ??
            photo.urls?.raw ??
            ""
        ),
        imageAlt: clip(photo.alt_description || photo.description, 160),
        imageWidth: photo.width,
        imageHeight: photo.height,
        imageCreator: clip(photo.user?.name, 160),
        imageCredit: photo.user?.name
          ? `Photo by ${photo.user.name} on Unsplash`
          : "Unsplash",
        imageLicense: "Unsplash license",
        imageLicenseUrl: "https://unsplash.com/license",
        provider: "unsplash",
        rank: index + 1
      };
    })
    .filter((result) => result.url && result.imageUrl);
}
