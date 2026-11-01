// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import { CodexTaskApprovalPermission, canConfigureCodexTaskApproval } from "./CodexTaskApprovalPermission";

const access = (role: string, status = "active", companyId = "company") => ({ source: "session", isInstanceAdmin: false,
  memberships: [{ companyId, status, membershipRole: role }] }) as CurrentBoardAccess;
describe("Codex task confirmation permission", () => {
  it.each(["admin", "operator", "viewer", "member"])("does not let a %s opt in", role => {
    expect(canConfigureCodexTaskApproval(access(role), "company")).toBe(false);
  });
  it("requires active ownership of the target company", () => {
    expect(canConfigureCodexTaskApproval(access("owner"), "company")).toBe(true);
    expect(canConfigureCodexTaskApproval(access("owner", "suspended"), "company")).toBe(false);
    expect(canConfigureCodexTaskApproval(access("owner", "active", "other"), "company")).toBe(false);
    expect(canConfigureCodexTaskApproval(undefined, "company")).toBe(false);
    expect(canConfigureCodexTaskApproval(access("owner"), undefined)).toBe(false);
  });
  it.each(["local_implicit", "instance_admin"])("honors the existing %s owner exception", source => {
    expect(canConfigureCodexTaskApproval({ ...access("operator"), source, isInstanceAdmin: source === "instance_admin" }, "company")).toBe(true);
  });
  it("waits for saved server state and blocks repeated requests while pending", async () => {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const change = vi.fn();
    async function render(checked: boolean, pending = false, board = access("owner")) {
      await act(async () => root.render(<CodexTaskApprovalPermission checked={checked} pending={pending} access={board} companyId="company" onCheckedChange={change} />));
      return host.querySelector("button")!;
    }
    try {
      let button = await render(false); await act(async () => button.click()); expect(change).toHaveBeenCalledWith(true);
      expect(button.getAttribute("aria-checked")).toBe("false");
      button = await render(false, true); await act(async () => button.click()); expect(change).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
      expect(host.textContent).toContain("Saving permissions");
      button = await render(true); expect(button.getAttribute("aria-checked")).toBe("true");
      button = await render(true, false, access("operator")); expect(button.disabled).toBe(true); expect(host.textContent).toContain("Only a company owner");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it("blocks uncertain writes and offers a check without resubmitting", async () => {
    const host = document.createElement("div"); const root = createRoot(host); const change = vi.fn(); const check = vi.fn();
    try {
      await act(async () => root.render(<CodexTaskApprovalPermission checked={false} access={access("owner")} companyId="company" pending={false} uncertain onCheckSaved={check} onCheckedChange={change} />));
      const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
      expect(toggle.disabled).toBe(true); expect(host.textContent).toContain("Save outcome unknown");
      await act(async () => toggle.click()); expect(change).not.toHaveBeenCalled();
      await act(async () => (host.querySelector('button:not([role="switch"])') as HTMLButtonElement).click()); expect(check).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); }
  });

});
