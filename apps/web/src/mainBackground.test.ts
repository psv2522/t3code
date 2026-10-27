import { describe, expect, it, vi } from "vite-plus/test";

import { ditherPixels } from "./mainBackground";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function setupBackground(source?: Blob, storageError = false) {
  vi.resetModules();
  const { startMainBackground } = await import("./mainBackground");
  const readStarted = deferred();
  const decodeStarted = deferred();
  const decoded = deferred();
  const root = { style: { setProperty: vi.fn(), removeProperty: vi.fn() }, dataset: {} };
  const read = () => {
    readStarted.resolve();
    return { result: source };
  };
  const db = {
    transaction: () => {
      const transaction = new EventTarget();
      queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
      return Object.assign(transaction, { objectStore: () => ({ get: read }) });
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = Object.assign(new EventTarget(), {
        result: db,
        error: new Error("Storage unavailable"),
      });
      queueMicrotask(() => request.dispatchEvent(new Event(storageError ? "error" : "success")));
      return request;
    },
  });
  vi.stubGlobal("window", {
    localStorage: { getItem: () => "35" },
    screen: { width: 4, height: 4 },
    innerWidth: 4,
    innerHeight: 4,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: root,
    createElement: () => ({
      getContext: () => ({
        drawImage: vi.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        putImageData: vi.fn(),
      }),
      toBlob: (callback: BlobCallback) => callback(new Blob(["rendered"])),
    }),
  });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4, height: 4, close: vi.fn() }));
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode() {
        decodeStarted.resolve();
        return decoded.promise;
      }
    },
  );
  return { startMainBackground, readStarted, decodeStarted, decoded, root };
}

describe("background startup", () => {
  it("keeps startup pending until the saved background is decoded and applied", async () => {
    const fixture = await setupBackground(new Blob(["source"]));
    let ready = false;
    const startup = Promise.resolve(fixture.startMainBackground()).then((dispose) => {
      ready = true;
      return dispose;
    });
    try {
      await fixture.readStarted.promise;
      expect(ready).toBe(false);
      await fixture.decodeStarted.promise;
      expect(fixture.root.dataset).not.toHaveProperty("mainBackground");
      fixture.decoded.resolve();
      await startup;
      expect(fixture.root.dataset).toHaveProperty("mainBackground");
      expect(fixture.root.style.setProperty).toHaveBeenCalledWith(
        "--main-background-image",
        expect.stringContaining("blob:"),
      );
    } finally {
      fixture.decoded.resolve();
      (await startup)();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { reason: "there is no saved image", storageError: false },
    { reason: "storage is unavailable", storageError: true },
  ])("continues without a background when $reason", async ({ storageError }) => {
    const fixture = await setupBackground(undefined, storageError);
    try {
      const dispose = await fixture.startMainBackground();
      expect(fixture.root.dataset).not.toHaveProperty("mainBackground");
      dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("continues startup and releases the image URL when decoding fails", async () => {
    const fixture = await setupBackground(new Blob(["source"]));
    using revoke = vi.spyOn(URL, "revokeObjectURL");
    const startup = fixture.startMainBackground();
    try {
      await fixture.decodeStarted.promise;
      fixture.decoded.reject(new Error("Image could not be decoded"));
      await startup;
      expect(fixture.root.dataset).not.toHaveProperty("mainBackground");
      expect(revoke).toHaveBeenCalledOnce();
    } finally {
      fixture.decoded.resolve();
      (await startup)();
      vi.unstubAllGlobals();
    }
  });
});

function solid(width: number, height: number, value: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data.set([value, value, value, 200], index);
  }
  return data;
}

describe("ditherPixels", () => {
  it("splits a flat tone between the two nearest levels with gray grain", () => {
    const data = solid(16, 16, 128);
    ditherPixels(data, 16);

    const lows: number[] = [];
    const highs: number[] = [];
    for (let index = 0; index < data.length; index += 4) {
      expect(data[index]).toBe(data[index + 1]);
      expect(data[index]).toBe(data[index + 2]);
      expect(data[index + 3]).toBe(200);
      (data[index]! < 128 ? lows : highs).push(data[index]!);
    }
    expect(lows.length).toBe(128);
    expect(highs.length).toBe(128);
    expect(Math.min(...lows)).toBeGreaterThanOrEqual(85 - 18);
    expect(Math.max(...highs)).toBeLessThanOrEqual(170 + 18);
  });

  it("is deterministic", () => {
    const first = solid(9, 7, 60);
    const second = solid(9, 7, 60);
    ditherPixels(first, 9);
    ditherPixels(second, 9);
    expect(first).toEqual(second);
  });
});
