// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, defaultScheduler, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyHomeRedirect } from "./CompanyHomeRedirect";
import { useCompanyHomePath } from "@/hooks/useCompanyHomePath";

const experimental = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: experimental }));
vi.mock("@/lib/router", () => ({
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(replace ?? false)} />
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
  vi.clearAllMocks();
  notifyManager.setScheduler(defaultScheduler);
});

// Wait for the observable React commit, not a guessed timer duration. Each
// poll flushes React work while React Query keeps its real async scheduler.
async function waitForView(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assertion();
  });
}

async function render(node: React.ReactNode, settle = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  teardown = () => { act(() => root.unmount()); host.remove(); client.clear(); };
  if (settle) await waitForView(() => expect(host.childElementCount).toBeGreaterThan(0));
  return host;
}

function HomePathProbe() {
  const home = useCompanyHomePath();
  return <span data-path={home.path} data-loaded={String(home.loaded)} />;
}

describe("CompanyHomeRedirect", () => {
  it("redirects to Dashboard while Responsibilities is off", async () => {
    experimental.getExperimental.mockResolvedValue({ enableResponsibilities: false });
    const host = await render(<CompanyHomeRedirect />);
    expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/dashboard");
  });

  it("redirects to Responsibilities while the flag is on", async () => {
    experimental.getExperimental.mockResolvedValue({ enableResponsibilities: true });
    const host = await render(<CompanyHomeRedirect />);
    const navigate = host.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-to")).toBe("/responsibilities");
    expect(navigate?.getAttribute("data-replace")).toBe("true");
  });

  it("renders nothing while the flag loads, then a single redirect", async () => {
    let resolve: (value: unknown) => void = () => {};
    experimental.getExperimental.mockReturnValue(new Promise((done) => { resolve = done; }));
    const host = await render(<CompanyHomeRedirect />, false);
    expect(host.querySelector('[data-testid="navigate"]')).toBeNull();
    await act(async () => { resolve({ enableResponsibilities: true }); });
    await waitForView(() => expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/responsibilities"));
    expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/responsibilities");
  });
});

describe("when the settings cannot be read", () => {
  it("shows the failure with Retry instead of redirecting, then redirects once it loads", async () => {
    experimental.getExperimental.mockRejectedValueOnce(new Error("Server error"));
    const host = await render(<CompanyHomeRedirect />);
    expect(host.querySelector('[data-testid="navigate"]')).toBeNull();
    expect(host.querySelector('[data-query-view="error"]')).not.toBeNull();
    experimental.getExperimental.mockResolvedValue({ enableResponsibilities: true });
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry"))!;
    await act(async () => { retry.click(); });
    await waitForView(() => expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/responsibilities"));
    expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/responsibilities");
  });
});

describe("useCompanyHomePath", () => {
  it("falls back to Dashboard for links while loading, marked not loaded", async () => {
    experimental.getExperimental.mockReturnValue(new Promise(() => {}));
    const host = await render(<HomePathProbe />, false);
    const probe = host.querySelector("span");
    expect(probe?.getAttribute("data-path")).toBe("/dashboard");
    expect(probe?.getAttribute("data-loaded")).toBe("false");
  });
});


it("does not redirect until the resolved flag notification is delivered", async () => {
  const notifications: Array<() => void> = [];
  notifyManager.setScheduler(callback => { notifications.push(callback); });
  let resolve!: (value: { enableResponsibilities: boolean }) => void;
  experimental.getExperimental.mockReturnValue(new Promise(done => { resolve = done; }));
  const host = await render(<CompanyHomeRedirect />, false);
  await act(async () => { resolve({ enableResponsibilities: true }); });
  expect(notifications.length).toBeGreaterThan(0);
  expect(host.querySelector('[data-testid="navigate"]')).toBeNull();
  await act(async () => { for (const notify of notifications.splice(0)) notify(); });
  await waitForView(() => {
    expect(host.querySelectorAll('[data-testid="navigate"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/responsibilities");
    expect(host.querySelector('[data-testid="navigate"]')?.getAttribute("data-replace")).toBe("true");
  });
});
