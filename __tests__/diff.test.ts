import { describe, it, expect, beforeEach } from "vitest";
import { filterPaths, readFileContents } from "../src/diff";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("filterPaths", () => {
  const paths = [
    "infrastructure/main.tf",
    "infrastructure/modules/s3/main.tf",
    "src/app.ts",
    "docs/setup.md",
    "test/compliance.test.ts",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ];

  it("returns all paths when no filters provided", () => {
    expect(filterPaths(paths, [], [])).toEqual(paths);
  });

  it("filters by include pattern", () => {
    const result = filterPaths(paths, ["*.tf"], []);
    expect(result).toEqual([]);
    // minimatch needs ** for subdirectory matching
    const result2 = filterPaths(paths, ["**/*.tf"], []);
    expect(result2).toEqual([
      "infrastructure/main.tf",
      "infrastructure/modules/s3/main.tf",
    ]);
  });

  it("filters by exclude pattern", () => {
    const result = filterPaths(paths, [], ["docs/**", "test/**"]);
    expect(result).toEqual([
      "infrastructure/main.tf",
      "infrastructure/modules/s3/main.tf",
      "src/app.ts",
      "docker-compose.yml",
      ".github/workflows/ci.yml",
    ]);
  });

  it("applies both include and exclude", () => {
    const result = filterPaths(
      paths,
      ["**/*.tf", "**/*.yml", "**/*.yaml"],
      [".github/**"],
    );
    expect(result).toEqual([
      "infrastructure/main.tf",
      "infrastructure/modules/s3/main.tf",
      "docker-compose.yml",
    ]);
  });

  it("returns empty array when include matches nothing", () => {
    const result = filterPaths(paths, ["**/*.go"], []);
    expect(result).toEqual([]);
  });
});

describe("readFileContents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-test-"));
  });

  it("reads file contents from disk", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "const b = 2;");

    const result = readFileContents(["a.ts", "b.ts"], tmpDir);
    expect(result).toEqual([
      { path: "a.ts", content: "const a = 1;" },
      { path: "b.ts", content: "const b = 2;" },
    ]);
  });

  it("skips files larger than 512 KB", () => {
    fs.writeFileSync(path.join(tmpDir, "big.ts"), "x".repeat(513 * 1024));
    fs.writeFileSync(path.join(tmpDir, "small.ts"), "ok");

    const result = readFileContents(["big.ts", "small.ts"], tmpDir);
    expect(result).toEqual([{ path: "small.ts", content: "ok" }]);
  });

  it("skips unreadable files", () => {
    const result = readFileContents(["nonexistent.ts"], tmpDir);
    expect(result).toEqual([]);
  });

  it("enforces the 500 file cap", () => {
    // Create 502 files
    for (let i = 0; i < 502; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `file ${i}`);
    }
    const paths = Array.from({ length: 502 }, (_, i) => `f${i}.ts`);

    const result = readFileContents(paths, tmpDir);
    expect(result.length).toBe(500);
  });
});
