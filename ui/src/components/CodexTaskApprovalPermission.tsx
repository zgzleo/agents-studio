import { useId } from "react";
import type { CurrentBoardAccess } from "@/api/access";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export function canConfigureCodexTaskApproval(access: CurrentBoardAccess | undefined, companyId: string | undefined) {
  if (!access || !companyId) return false;
  return access.source === "local_implicit" || access.isInstanceAdmin || access.memberships?.some(
    (membership) => membership.companyId === companyId && membership.status === "active" && membership.membershipRole === "owner",
  ) === true;
}

export function CodexTaskApprovalPermission({ checked, access, companyId, pending, uncertain = false, checking = false, onCheckSaved, onCheckedChange }: {
  checked: boolean;
  access: CurrentBoardAccess | undefined;
  companyId: string | undefined;
  pending: boolean;
  uncertain?: boolean;
  checking?: boolean;
  onCheckSaved?: () => void;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  const canConfigure = canConfigureCodexTaskApproval(access, companyId);
  return <div className="flex items-center justify-between gap-4 text-sm">
    <div className="space-y-1">
      <label id={`${id}-label`} htmlFor={id}>Allow Codex task creation without confirmation</label>
      <p id={`${id}-description`} className="text-xs text-muted-foreground">
        Only the managed paperclip-projects.create_task tool skips Codex confirmation. Other tools and sandbox restrictions stay unchanged. Applies on the next eligible Codex CLI run.
      </p>
      {!canConfigure && <p className="text-xs text-muted-foreground">Only a company owner can change this permission.</p>}
      {uncertain && <div className="space-y-1">
        <p role="alert" className="text-xs text-muted-foreground">Save outcome unknown. Check the saved permission before making another change.</p>
        <Button variant="outline" size="sm" disabled={checking} onClick={onCheckSaved}>{checking ? "Checking…" : "Check saved permission"}</Button>
      </div>}
      {pending && <p role="status" className="text-xs text-muted-foreground">Saving permissions…</p>}
    </div>
    <ToggleSwitch id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`}
      checked={checked} onCheckedChange={(next) => { if (canConfigure && !pending && !uncertain) onCheckedChange(next); }}
      disabled={!canConfigure || pending || uncertain} aria-busy={pending} />
  </div>;
}
