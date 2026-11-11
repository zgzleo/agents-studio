import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("resolves internal Codex creation once and preserves legacy agents through ordinary edits", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);
    const lifecycle = createAgentLifecycle(db);
    const native = await lifecycle.requestHire(companyId, { name: "New Codex", adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" }, status: "pending_approval" });
    const legacy = await lifecycle.requestHire(companyId, { name: "Legacy Codex", adapterType: "codex_local", runner: "legacy", adapterConfig: { extraArgs: ["--search"] }, status: "pending_approval" });
    const reviewedLegacy = await lifecycle.requestHire(companyId, { name: "Historical approved hire", adapterType: "codex_local", adapterConfig: {}, status: "pending_approval" }, { runnerResolved: true });
    if (paperclipRunnerSupportsPlatform("codex_local", process.platform, process.arch)) {
      expect(native).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", modelReasoningEffort: "high" } });
    } else {
      expect(native).toMatchObject({ adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" } });
    }
    expect(legacy.adapterType).toBe("codex_local");
    expect(reviewedLegacy.adapterType).toBe("codex_local");
    for (const agent of [native, legacy, reviewedLegacy]) {
      expect(agent).not.toHaveProperty("runner");
      await lifecycle.approveHire(agent.id);
      await service.update(agent.id, { title: "Updated title" });
      const saved = await service.getById(agent.id);
      expect(saved?.adapterType).toBe(agent.adapterType);
      expect(saved?.adapterConfig).toEqual(agent.adapterConfig);
    }
  });

  it("cannot grant or revoke the Codex owner opt-in through generic/import-style configuration", async () => {
    const companyId = await seedCompany();
    const [agent] = await db.insert(agents).values({ companyId, name: "Import policy fixture", adapterType: "process", permissions: { canCreateAgents: false } }).returning();
    const service = agentService(db);
    await service.update(agent.id, { permissions: { canCreateAgents: false, codexProjectTaskAutoApprove: true } });
    expect((await service.getById(agent.id))?.permissions.codexProjectTaskAutoApprove).not.toBe(true);
    await service.updatePermissions(agent.id, { canCreateAgents: false, codexProjectTaskAutoApprove: true });
    await service.update(agent.id, { permissions: { canCreateAgents: false, codexProjectTaskAutoApprove: false } });
    expect((await service.getById(agent.id))?.permissions.codexProjectTaskAutoApprove).toBe(true);
  });

  it("preserves owner opt-in, CEO denial and interaction restrictions together on ordinary writes", async () => {
    const companyId = await seedCompany();
    const denial = { actorType: "user", actorId: "owner", at: "2026-11-11T00:00:00.000Z" };
    const interactions = { canConfigureOtherAgents: false, canReceiveConfigurationChangesFromAgents: false };
    const [agent] = await db.insert(agents).values({
      companyId, name: "Combined permission fixture", role: "ceo", adapterType: "process",
      permissions: { canCreateAgents: false, ceoHiringDeniedBy: denial, codexProjectTaskAutoApprove: true, interactions },
    }).returning();
    const service = agentService(db);
    await service.update(agent.id, { permissions: { canCreateSkills: false, codexProjectTaskAutoApprove: false,
      ceoHiringDeniedBy: { actorType: "user", actorId: "forged", at: "later" } } } as never);
    expect((await service.getById(agent.id))?.permissions).toMatchObject({
      canCreateAgents: false, canCreateSkills: false, ceoHiringDeniedBy: denial,
      codexProjectTaskAutoApprove: true, interactions,
    });
    await service.updatePermissions(agent.id, { canCreateAgents: false, codexProjectTaskAutoApprove: false });
    expect((await service.getById(agent.id))?.permissions).toMatchObject({
      canCreateAgents: false, ceoHiringDeniedBy: denial, codexProjectTaskAutoApprove: false, interactions,
    });
    await expect(service.updatePermissions(agent.id, { canCreateAgents: false, interactions: {} })).rejects.toMatchObject({ status: 403 });
    expect((await service.getById(agent.id))?.permissions).toMatchObject({ interactions, codexProjectTaskAutoApprove: false });
  });

  it.each(["permissions", "configuration"] as const)("preserves an owner revocation across an overlapping %s update", async (kind) => {
    const companyId = await seedCompany();
    const [agent] = await db.insert(agents).values({ companyId, name: "Concurrent permission fixture", adapterType: "process", permissions: { canCreateAgents: false, codexProjectTaskAutoApprove: true } }).returning();
    const applicationName = `permission-race-${randomUUID()}`;
    const writer = createDb(tempDb!.connectionString, { applicationName });
    let ordinaryWrite: Promise<unknown> | undefined;
    try {
      await db.transaction(async owner => {
        // Hold an uncommitted owner revocation. A stale, unlocked reader sees
        // true and must not be allowed to write it back after this commits.
        await owner.select().from(agents).where(eq(agents.id, agent.id)).for("no key update");
        await owner.update(agents).set({ permissions: { canCreateAgents: false, codexProjectTaskAutoApprove: false } }).where(eq(agents.id, agent.id));
        const service = agentService(writer);
        ordinaryWrite = kind === "permissions"
          ? service.updatePermissions(agent.id, { canCreateAgents: true })
          : service.update(agent.id, { permissions: { canCreateAgents: true } });
        // Observe a real database lock wait instead of relying on a sleep to
        // guess whether the overlapping writer has reached the critical point.
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });
      });
      await ordinaryWrite;
      expect((await agentService(db).getById(agent.id))?.permissions).toMatchObject({ canCreateAgents: true, codexProjectTaskAutoApprove: false });
    } finally {
      await ordinaryWrite?.catch(() => {});
      await writer.$client.end({ timeout: 1 });
    }
  });

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const agentSvcLifecycle = createAgentLifecycle(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvcLifecycle.requestHire(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "paused",
      lifecycleState: "preparing",
      appearance: pending.appearance,
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  it("keeps a CEO's hiring authority as saved when another permission changes", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);
    const insertCeo = (permissions: Record<string, unknown>) => db.insert(agents).values({
      companyId, name: `CEO ${randomUUID()}`, role: "ceo", permissions,
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning().then(rows => rows[0]!);
    const stored = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0]!.permissions as Record<string, unknown>);

    const legacy = await insertCeo({});
    await service.updatePermissions(legacy.id, { canCreateSkills: false } as never);
    expect(await stored(legacy.id)).toMatchObject({ canCreateAgents: true, canCreateSkills: false });

    const unrecorded = await insertCeo({ canCreateAgents: false, canCreateSkills: true });
    await service.updatePermissions(unrecorded.id, { canCreateSkills: false } as never);
    expect(await stored(unrecorded.id)).toMatchObject({ canCreateAgents: true, canCreateSkills: false });

    const denial = { actorType: "user", actorId: "board-user", at: "2026-11-08T00:00:00.000Z" };
    const denied = await insertCeo({ canCreateAgents: false, canCreateSkills: true, ceoHiringDeniedBy: denial });
    await service.updatePermissions(denied.id, { canCreateSkills: false } as never);
    expect(await stored(denied.id)).toMatchObject({ canCreateAgents: false, canCreateSkills: false, ceoHiringDeniedBy: denial });

    // An import update whose manifest omits the field keeps the board's denial,
    // and a supplied denial record is never taken from input.
    await service.update(denied.id, { permissions: {} } as never);
    expect(await stored(denied.id)).toMatchObject({ canCreateAgents: false, ceoHiringDeniedBy: denial });
    const open = await insertCeo({ canCreateAgents: true });
    await service.update(open.id, { permissions: { canCreateAgents: false, ceoHiringDeniedBy: denial } } as never);
    expect(await stored(open.id)).not.toHaveProperty("ceoHiringDeniedBy");
  });
});
