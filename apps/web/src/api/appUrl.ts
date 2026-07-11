function normalizedBasePath(): string {
  const configured = import.meta.env?.BASE_URL || "/";
  const withLeadingSlash = configured.startsWith("/")
    ? configured
    : `/${configured}`;
  return withLeadingSlash === "/"
    ? ""
    : withLeadingSlash.replace(/\/+$/, "");
}

export function appUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBasePath()}${normalizedPath}` || "/";
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/api")
    ? path
    : `/api${path.startsWith("/") ? path : `/${path}`}`;
  return appUrl(normalizedPath);
}
