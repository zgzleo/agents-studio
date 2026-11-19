import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGrokRemoteProjectAssets } from "./remote-project-assets.js";

it.each(["existing", "new", "unsafe", "changed"])("keeps %s project files safe while staging Grok runtime assets", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets"), outside = path.join(root, "outside");
    await fs.mkdir(cwd); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const stagedSkill = path.join(assets, ".claude/skills/selected");
    await fs.mkdir(stagedSkill, { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "selected skill");
    await fs.writeFile(path.join(assets, "Agents.md"), "agent instructions");
    if (scenario === "existing") {
      await fs.mkdir(path.join(cwd, ".claude/skills/own"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".claude/skills/own/keep.txt"), "user skill");
    }
    if (scenario === "unsafe") await fs.symlink(outside, path.join(cwd, ".claude"));
    const input = { runId: "fixture", target: { kind: "local" as const }, cwd, assets };
    if (scenario === "unsafe") {
      await expect(prepareGrokRemoteProjectAssets(input)).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
      return;
    }
    const prepared = await prepareGrokRemoteProjectAssets(input);
    expect(prepared.rulesFilePath).toBe(path.join(assets, "Agents.md"));
    expect(await fs.readFile(path.join(cwd, ".claude/skills/selected/SKILL.md"), "utf8")).toBe("selected skill");
    if (scenario === "changed") {
      await fs.rename(path.join(cwd, ".claude"), path.join(cwd, ".claude-original"));
      await fs.symlink(outside, path.join(cwd, ".claude"));
      await expect(prepared.cleanup()).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    } else {
      await fs.writeFile(path.join(cwd, ".claude/user.txt"), "user work");
      await prepared.cleanup();
      expect(await fs.readFile(path.join(cwd, ".claude/user.txt"), "utf8")).toBe("user work");
      await expect(fs.stat(path.join(cwd, ".claude/skills/selected"))).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "existing") expect(await fs.readFile(path.join(cwd, ".claude/skills/own/keep.txt"), "utf8")).toBe("user skill");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


it.each(["same-name", "dangling-skill", "copy-failure", "concurrent"])("preserves ownership for %s staging", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-ownership-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets");
    const skill = path.join(cwd, ".claude/skills/selected");
    const source = path.join(assets, ".claude/skills/selected");
    await fs.mkdir(cwd);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "runtime");
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested/data"), "nested");
    if (scenario === "same-name") {
      await fs.mkdir(skill, { recursive: true });
      await fs.writeFile(path.join(skill, "SKILL.md"), "user");
    }
    if (scenario === "dangling-skill") {
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.symlink(path.join(root, "missing"), skill);
    }
    if (scenario === "copy-failure") {
      // A FIFO cannot be copied: exercise rollback after ownership is acquired.
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [path.join(source, "unsupported-fifo")]);
    }
    const input = { runId: "fixture", target: { kind: "local" as const }, cwd, assets };
    if (scenario === "copy-failure") {
      await expect(prepareGrokRemoteProjectAssets(input)).rejects.toThrow("Could not prepare");
      await expect(fs.lstat(path.join(cwd, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    const prepared = scenario === "concurrent"
      ? await Promise.all([prepareGrokRemoteProjectAssets(input), prepareGrokRemoteProjectAssets(input)])
      : [await prepareGrokRemoteProjectAssets(input)];
    if (scenario === "dangling-skill") expect((await fs.lstat(skill)).isSymbolicLink()).toBe(true);
    else expect(await fs.readFile(path.join(skill, "SKILL.md"), "utf8")).toBe(scenario === "same-name" ? "user" : "runtime");
    if (scenario === "concurrent") expect(await fs.readFile(path.join(skill, "nested/data"), "utf8")).toBe("nested");
    for (const entry of prepared) await entry.cleanup();
    if (scenario === "same-name") expect(await fs.readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("user");
    if (scenario === "dangling-skill") expect((await fs.lstat(skill)).isSymbolicLink()).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
