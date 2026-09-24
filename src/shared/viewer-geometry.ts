export interface Size { width: number; height: number }
export interface ViewTransform { x: number; y: number; scale: number }
export interface Point { x: number; y: number }

export function fitImage(image: Size, viewport: Size): ViewTransform {
  const scale = Math.min(16, Math.max(1, viewport.width - 48) / image.width,
    Math.max(1, viewport.height - 48) / image.height);
  return { scale, x: (viewport.width - image.width * scale) / 2,
    y: (viewport.height - image.height * scale) / 2 };
}

export function clampView(view: ViewTransform, image: Size, viewport: Size): ViewTransform {
  const width = image.width * view.scale;
  const height = image.height * view.scale;
  return {
    scale: view.scale,
    x: width <= viewport.width ? (viewport.width - width) / 2
      : Math.max(viewport.width - width, Math.min(0, view.x)),
    y: height <= viewport.height ? (viewport.height - height) / 2
      : Math.max(viewport.height - height, Math.min(0, view.y)),
  };
}

export function zoomAt(view: ViewTransform, nextScale: number, anchor: Point,
  image: Size, viewport: Size): ViewTransform {
  const minScale = Math.min(0.05, fitImage(image, viewport).scale);
  const scale = Math.max(minScale, Math.min(16, nextScale));
  const ratio = scale / view.scale;
  return clampView({ scale, x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio }, image, viewport);
}

export function sameAspectRatio(a: Size, b: Size): boolean {
  return Math.abs((a.width / a.height) / (b.width / b.height) - 1) <= 0.005;
}
