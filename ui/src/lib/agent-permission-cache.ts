import type { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export async function cacheAgentPermissionResponse(client: QueryClient, refs: string[], saved: AgentDetail) {
  const keys = [...new Set(refs)].map(ref => queryKeys.agents.detail(ref));
  // A pre-save read must not overwrite the acknowledged write.
  await Promise.all(keys.map(queryKey => client.cancelQueries({ queryKey })));
  for (const queryKey of keys) {
    client.setQueriesData<AgentDetail>({ queryKey }, current => current
      ? current.id === saved.id && current.companyId === saved.companyId
        ? { ...current, permissions: saved.permissions, access: saved.access }
        : current
      : current);
  }
}
