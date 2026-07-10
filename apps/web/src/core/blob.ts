export type BlobDataUrlReader = {
  result: string | ArrayBuffer | null;
  error: Error | null;
  addEventListener(type: "load" | "error", listener: () => void): void;
  readAsDataURL(blob: Blob): void;
};

function createBrowserReader(): BlobDataUrlReader {
  return new FileReader();
}

export function blobToDataUrl(
  blob: Blob,
  createReader: () => BlobDataUrlReader = createBrowserReader
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = createReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not encode the rendered screenshot."));
    });
    reader.addEventListener("error", () => {
      reject(
        reader.error ?? new Error("Could not read the rendered screenshot.")
      );
    });
    reader.readAsDataURL(blob);
  });
}
