import type { ImageEditOptions } from "../../../shared/image-tools";
import type { ImageSize } from "../../../shared/image-tool-ui";

export interface RecoveryImage extends ImageSize { id: string; name: string; bytes: Uint8Array; size: number }
export interface StudioRecovery {
  images: RecoveryImage[]; pdfImages: RecoveryImage[]; sourceId?: string; watermarkImage: RecoveryImage | null;
  options: ImageEditOptions; cropReference: ImageSize | null; ratioLocked: boolean; cropRatio: string;
  watermarkKind: "text" | "image"; pdfSize: "image" | "a4" | "a4-landscape"; pdfQuality: number;
  disabledEdits: string[]; interrupted: boolean;
}
type Metadata = Omit<StudioRecovery, "images" | "pdfImages" | "watermarkImage"> & {
  images: string[]; pdfImages: string[]; watermarkImage: string | null; watermarkHasImage: boolean;
};
const KEY = "clarune.studio-recovery.v2";
let retainedKey = "!uninitialized";
let retainedIds = new Set<string>();
const incomingIds = new Set<string>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("clarune-local-recovery", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("images")) request.result.createObjectStore("images", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
// Blob writes finish before an import becomes editable. Parameter edits never
// clone or rewrite source bytes; their small metadata is committed synchronously.
export async function cacheRecoveryImages(images: RecoveryImage[]): Promise<void> {
  if (!images.length) return;
  for (const image of images) incomingIds.add(image.id);
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("images", "readwrite");
    for (const image of images) { const { id, name, bytes, size, width, height } = image; tx.objectStore("images").put({ id, name, bytes, size, width, height }); }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
export async function readStudioRecovery(): Promise<StudioRecovery | null> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const metadata = JSON.parse(raw) as Metadata;
  const db = await database();
  const images = await new Promise<RecoveryImage[]>((resolve, reject) => {
    const tx = db.transaction("images", "readonly"), request = tx.objectStore("images").getAll();
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
  const byId = new Map(images.map((image) => [image.id, image]));
  const read = (id: string) => { const image = byId.get(id); if (!image) throw new Error("Recovery image missing"); return image; };
  const watermarkImage = metadata.watermarkImage ? read(metadata.watermarkImage) : null;
  const options = { ...metadata.options };
  if (options.watermark && metadata.watermarkHasImage && watermarkImage) options.watermark = { ...options.watermark, image: watermarkImage.bytes };
  return { ...metadata, images: metadata.images.map(read), pdfImages: metadata.pdfImages.map(read), watermarkImage, options };
}
export function writeStudioRecovery(value: StudioRecovery | null): Promise<void> {
  const ids = value ? [...value.images, ...value.pdfImages, ...(value.watermarkImage ? [value.watermarkImage] : [])].map((image) => image.id) : [];
  retainedIds = new Set(ids);
  for (const id of ids) incomingIds.delete(id);
  if (!value) incomingIds.clear();
  if (value) {
    const options = { ...value.options, watermark: value.options.watermark ? { ...value.options.watermark, image: undefined } : undefined };
    const metadata: Metadata = { ...value, images: value.images.map((image) => image.id), pdfImages: value.pdfImages.map((image) => image.id),
      watermarkImage: value.watermarkImage?.id ?? null, watermarkHasImage: !!value.options.watermark?.image, options };
    localStorage.setItem(KEY, JSON.stringify(metadata));
  } else localStorage.removeItem(KEY);
  const key = [...retainedIds].sort().join(",");
  if (key === retainedKey) return Promise.resolve();
  retainedKey = key;
  return database().then((db) => new Promise<void>((resolve, reject) => {
    const keep = new Set([...retainedIds, ...incomingIds]);
    const tx = db.transaction("images", "readwrite"), store = tx.objectStore("images"), request = store.openKeyCursor();
    request.onsuccess = () => { const cursor = request.result; if (cursor) { if (!keep.has(String(cursor.key))) store.delete(cursor.key); cursor.continue(); } };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); retainedKey = ""; reject(tx.error); };
  }));
}
