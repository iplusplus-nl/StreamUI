export type SearchProvider =
  | "auto"
  | "brave"
  | "tavily"
  | "serper"
  | "duckduckgo"
  | "none";

export type BrowserEngine = "fetch" | "playwright";

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

export type VerifiedImage = RetrievedImage & {
  sourceId: number;
  sourceTitle?: string;
  sourceUrl: string;
  contentType?: string;
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

export type SearchResult = {
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
  freshnessFiltered?: boolean;
  provider: string;
  rank: number;
};

export type RetrievalConfig = {
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
  signal?: AbortSignal;
};

export type RetrievalOptions = {
  forceSearch?: boolean;
  forceFetch?: boolean;
  intentText?: string;
  searchSettings?: unknown;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
};

export type ParsedPageSource = RetrievalSource & {
  htmlCharCount?: number;
  scriptCount?: number;
  bodyTextCharCount?: number;
};
