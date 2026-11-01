import { afterEach, describe, expect, it, vi } from "vitest";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { assertManagedAiProjectAuth } from "./ai-connection-runtime.js";

describe("managed AI MCP policy override boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { extraArgs: ["-c", 'mcp_servers.projects.tools.create_task.approval_mode="approve"'] },
    { args: ['--config=mcp_servers.projects.tools.create_task.approval_mode="approve"'] },
  ])("rejects a per-tool override before touching the execution target: %j", async config => {
    const execute = vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess");
    await expect(assertManagedAiProjectAuth(config, "openai", {
      kind: "remote", transport: "sandbox", remoteCwd: "/fixture-not-accessed",
    } as Parameters<typeof assertManagedAiProjectAuth>[2])).rejects.toMatchObject({
      status: 422, details: { code: "ai_connection_incompatible" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
