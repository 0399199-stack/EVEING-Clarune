/** Production exports must not be lost to Chromium development shortcuts. */
export function isDevelopmentShortcut(input: { key: string; control: boolean; meta: boolean; shift: boolean }): boolean {
  const key = input.key.toLowerCase();
  return key === "f5" || key === "f12" || ((input.control || input.meta) && (key === "r" || (input.shift && ["i", "j", "c"].includes(key))));
}
