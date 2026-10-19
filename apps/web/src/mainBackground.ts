import { useSyncExternalStore } from "react";

const DATABASE_NAME = "t3code:main-background";
const STORE_NAME = "images";
const IMAGE_KEY = "current";
const OPACITY_STORAGE_KEY = "t3code:main-background-opacity";
const CHANNEL_NAME = "t3code:main-background";
const SOURCE_MAX_EDGE = 2560;
const CELL_SIZE = 2;
const LEVELS = 4;
const NOISE_AMPLITUDE = 18;

export const MIN_MAIN_BACKGROUND_OPACITY = 5;
export const MAX_MAIN_BACKGROUND_OPACITY = 100;
export const DEFAULT_MAIN_BACKGROUND_OPACITY = 35;

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

interface RenderedBackground {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export interface MainBackgroundState {
  readonly imageUrl: string | null;
  readonly opacity: number;
}

let rendered: RenderedBackground | null = null;
let state: MainBackgroundState = { imageUrl: null, opacity: DEFAULT_MAIN_BACKGROUND_OPACITY };
let generation = 0;
const listeners = new Set<() => void>();
let database: Promise<IDBDatabase> | undefined;

function noise(x: number, y: number) {
  let hash = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296 - 0.5;
}

export function ditherPixels(data: Uint8ClampedArray, width: number) {
  const step = 255 / (LEVELS - 1);
  for (let index = 0; index < data.length; index += 4) {
    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const threshold = (BAYER_8[(y & 7) * 8 + (x & 7)]! + 0.5) / 64 - 0.5;
    const grain = noise(x, y) * 2 * NOISE_AMPLITUDE;
    for (let channel = 0; channel < 3; channel++) {
      data[index + channel] = Math.round(data[index + channel]! / step + threshold) * step + grain;
    }
  }
}

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      type,
      quality,
    ),
  );
}

function canvasContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");
  context.imageSmoothingQuality = "high";
  return context;
}

async function shrinkSource(file: Blob) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvasContext(canvas).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, "image/webp", 0.92);
  } finally {
    bitmap.close();
  }
}

async function renderBackground(source: Blob): Promise<RenderedBackground> {
  const bitmap = await createImageBitmap(source);
  try {
    const columns = Math.ceil(Math.max(window.screen.width, window.innerWidth) / CELL_SIZE);
    const rows = Math.ceil(Math.max(window.screen.height, window.innerHeight) / CELL_SIZE);
    const canvas = document.createElement("canvas");
    canvas.width = columns;
    canvas.height = rows;
    const context = canvasContext(canvas);
    const scale = Math.max(columns / bitmap.width, rows / bitmap.height);
    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (columns - drawWidth) / 2,
      (rows - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    const image = context.getImageData(0, 0, columns, rows);
    ditherPixels(image.data, columns);
    context.putImageData(image, 0, 0);
    const blob = await canvasToBlob(canvas, "image/png");
    return {
      url: URL.createObjectURL(blob),
      width: columns * CELL_SIZE,
      height: rows * CELL_SIZE,
    };
  } finally {
    bitmap.close();
  }
}

function readOpacity() {
  const value = Number(window.localStorage.getItem(OPACITY_STORAGE_KEY));
  return Number.isInteger(value) &&
    value >= MIN_MAIN_BACKGROUND_OPACITY &&
    value <= MAX_MAIN_BACKGROUND_OPACITY
    ? value
    : DEFAULT_MAIN_BACKGROUND_OPACITY;
}

function publish(next: Partial<MainBackgroundState>) {
  state = { ...state, ...next };
  const root = document.documentElement;
  root.style.setProperty("--main-background-opacity", `${state.opacity}%`);
  if (rendered) {
    root.style.setProperty("--main-background-image", `url("${rendered.url}")`);
    root.style.setProperty("--main-background-size", `${rendered.width}px ${rendered.height}px`);
    root.dataset.mainBackground = "";
  } else {
    root.style.removeProperty("--main-background-image");
    root.style.removeProperty("--main-background-size");
    delete root.dataset.mainBackground;
  }
  for (const listener of listeners) listener();
}

function replaceRendered(next: RenderedBackground | null) {
  const previous = rendered;
  rendered = next;
  publish({ imageUrl: next?.url ?? null });
  if (previous) URL.revokeObjectURL(previous.url);
}

async function show(source: Blob | undefined) {
  const current = ++generation;
  const next = source ? await renderBackground(source) : null;
  if (current !== generation) {
    if (next) URL.revokeObjectURL(next.url);
    return;
  }
  replaceRendered(next);
}

async function reload() {
  await show(await withStore<Blob | undefined>("readonly", (store) => store.get(IMAGE_KEY)));
}

function broadcast() {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage("changed");
  channel.close();
}

export async function setMainBackgroundImage(file: Blob) {
  const source = await shrinkSource(file);
  await show(source);
  await withStore("readwrite", (store) => store.put(source, IMAGE_KEY));
  broadcast();
}

export async function clearMainBackgroundImage() {
  await show(undefined);
  await withStore("readwrite", (store) => store.delete(IMAGE_KEY));
  broadcast();
}

export function setMainBackgroundOpacity(opacity: number) {
  window.localStorage.setItem(OPACITY_STORAGE_KEY, String(opacity));
  publish({ opacity });
}

export function startMainBackground() {
  publish({ opacity: readOpacity() });
  const load = () => void reload().catch(() => replaceRendered(null));
  load();

  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", load);
  const onStorage = (event: StorageEvent) => {
    if (event.key === OPACITY_STORAGE_KEY) publish({ opacity: readOpacity() });
  };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (
        rendered &&
        (window.innerWidth > rendered.width || window.innerHeight > rendered.height)
      ) {
        load();
      }
    }, 250);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("resize", onResize);
  return () => {
    clearTimeout(resizeTimer);
    channel.close();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("resize", onResize);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMainBackground() {
  return useSyncExternalStore(subscribe, () => state);
}
