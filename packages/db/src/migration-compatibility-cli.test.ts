import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ids = { remoteMain: "a".repeat(40), remoteMaster: "b".repeat(40), main: "c".repeat(40), master: "d".repeat(40) };

function check(refs: Record<string, string>, requested?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-cli-refs-")); dirs.push(dir);
  const journal = JSON.parse(readFileSync(path.join(root, "src/migrations/meta/_journal.json"), "utf8"));
  const files = journal.entries.map((entry: { tag: string }) => entry.tag + ".sql").join("\n");
  // Stub only Git's read-only ref inventory, not the migration classifier or its result.
  writeFileSync(path.join(dir, "git"), `#!${process.execPath}
const a=process.argv.slice(2),refs=JSON.parse(process.env.TEST_MIGRATION_REFS);
if(a[0]==="merge-base"){const base=refs[a[2]];if(!base)process.exit(1);console.log(base);}
else if(a[0]==="ls-tree"){console.log(process.env.TEST_MIGRATION_FILES);}
else process.exit(1);
`, { mode: 0o700 });
  return spawnSync(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"),
    path.join(root, "scripts/migration-compatibility.ts"), "--check", ...(requested ? ["--base", requested] : [])],
    { encoding: "utf8", env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
      TEST_MIGRATION_REFS: JSON.stringify(refs), TEST_MIGRATION_FILES: files } });
}

describe("migration compatibility CLI base selection", () => {
  it("prefers the fork remote main over an older remote master", () => {
    const result = check({ "origin/main": ids.remoteMain, "origin/master": ids.remoteMaster });
    expect(result.status).toBe(0); expect(result.stdout).toContain(ids.remoteMain.slice(0, 12));
  });
  it("preserves the upstream remote master fallback", () => {
    const result = check({ "origin/master": ids.remoteMaster, main: ids.main });
    expect(result.status).toBe(0); expect(result.stdout).toContain(ids.remoteMaster.slice(0, 12));
  });
  it("uses local main when remote branches are unavailable", () => {
    const result = check({ main: ids.main, master: ids.master });
    expect(result.status).toBe(0); expect(result.stdout).toContain(ids.main.slice(0, 12));
  });
  it("retains local master as the final fallback", () => {
    const result = check({ master: ids.master });
    expect(result.status).toBe(0); expect(result.stdout).toContain(ids.master.slice(0, 12));
  });
  it("uses an explicit base without silently choosing another branch", () => {
    const result = check({ custom: ids.master, "origin/main": ids.remoteMain }, "custom");
    expect(result.status).toBe(0); expect(result.stdout).toContain(ids.master.slice(0, 12));
    expect(check({ "origin/main": ids.remoteMain }, "missing").status).toBe(2);
  });
  it("reports unavailable history rather than inventing a successful baseline", () => {
    const result = check({});
    expect(result.status).toBe(0); expect(result.stdout).toContain("no merge base available, skipped");
  });
});
