import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";
import { cacheAgentPermissionResponse } from "./agent-permission-cache";
describe("acknowledged permission saves", () => {
  it("updates both detail aliases even when the following read is rate-limited", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stale = { id: "id", companyId: "company", permissions: { codexProjectTaskAutoApprove: true }, access: { canAssignTasks: true } } as AgentDetail;
    const keys = ["slug", "id"].map(ref => [...queryKeys.agents.detail(ref), "company"]);
    for (const key of keys) client.setQueryData(key, stale);
    const foreignKey = [...queryKeys.agents.detail("slug"), "other"];
    client.setQueryData(foreignKey, { ...stale, id: "foreign", companyId: "other" });
    const saved = { ...stale, permissions: { ...stale.permissions, codexProjectTaskAutoApprove: false } };
    await cacheAgentPermissionResponse(client, ["slug", "id"], saved);
    await expect(client.fetchQuery({ queryKey: keys[0], queryFn: async () => { throw new Error("429"); } })).rejects.toThrow("429");
    for (const key of keys) expect(client.getQueryData<AgentDetail>(key)?.permissions.codexProjectTaskAutoApprove).toBe(false);
    expect(client.getQueryData<AgentDetail>(foreignKey)?.permissions.codexProjectTaskAutoApprove).toBe(true);
    client.clear();
  });
});
