import { validateHeif } from "./imageDecodeValidation";
import { readBinaryPreview } from "./readBinaryPreview";

// heic-to/next needs eval, which the desktop CSP forbids, and heic-to/csp needs the DOM: keep HEIF off the worker.
async function decodeHeif(src: string, signal: AbortSignal) {
  const bytes = await readBinaryPreview(src, signal);
  validateHeif(bytes);
  const { heicTo } = await import("heic-to/csp");
  return await heicTo({ blob: new Blob([bytes]), type: "image/png" });
}

export async function decodeImagePreview(src: string, heif: boolean, signal: AbortSignal) {
  const worker = heif
    ? null
    : new Worker(new URL("./imageDecode.worker.ts", import.meta.url), { type: "module" });
  const controller = new AbortController();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      const abort = () => fail("Image decoding cancelled.");
      signal.addEventListener("abort", abort, { signal: controller.signal });
      if (signal.aborted) return abort();
      const timer = setTimeout(() => fail("This image took too long to decode."), 30_000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      if (!worker) {
        void decodeHeif(src, controller.signal).then(resolve, (cause: unknown) =>
          fail(cause instanceof Error ? cause.message : "Could not decode this image."),
        );
        return;
      }
      worker.addEventListener("error", () => fail("Could not load the image decoder."));
      worker.addEventListener("message", (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
        if (event.data.blob) resolve(event.data.blob);
        else fail(event.data.error ?? "Could not decode this image.");
      });
      void readBinaryPreview(src, controller.signal).then(
        (bytes) => worker.postMessage({ bytes }, [bytes]),
        reject,
      );
    });
  } finally {
    controller.abort();
    worker?.terminate();
  }
}
