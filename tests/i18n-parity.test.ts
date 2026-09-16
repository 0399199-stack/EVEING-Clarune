import { describe, expect, it } from "vitest";
import { enUS } from "../src/renderer/src/locales/en-US";
import { zhCN } from "../src/renderer/src/locales/zh-CN";

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, nested]) => keys(nested, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe("bilingual resource contract", () => {
  it("keeps Simplified Chinese and English keys in parity", () => {
    expect(keys(zhCN)).toEqual(keys(enUS));
  });

  it("contains no blank translations", () => {
    const leaves = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (!value || typeof value !== "object") return [];
      return Object.values(value as Record<string, unknown>).flatMap(leaves);
    };
    expect(leaves(zhCN).every((value) => value.trim().length > 0)).toBe(true);
    expect(leaves(enUS).every((value) => value.trim().length > 0)).toBe(true);
  });
});
