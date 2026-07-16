export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  // Artifact previews are script-only, opaque-origin sandboxes. Their srcdoc
  // documents need inline runtime and generated scripts to remain interactive.
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:"
].join("; ");
