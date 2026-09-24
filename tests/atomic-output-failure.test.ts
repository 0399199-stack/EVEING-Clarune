import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ link: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), link: mocks.link }));
import { writeNewFile } from "../src/main/image-tools/processor";

describe("atomic publication failures", () => {
  it.each(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"])("reports unsupported filesystem %s and leaves no partial final or scratch file", async (code) => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-unsupported-output-"));
    try {
      mocks.link.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(writeNewFile(join(directory, "output.png"), Buffer.alloc(1000, 17))).rejects.toThrow("OUTPUT_FILESYSTEM_UNSUPPORTED");
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
