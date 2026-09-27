import { fs01Adaptation } from "./fixtures/fs01-adaptation.js";
import { adaptationFixture } from "./fixtures/adaptation-package.js";
import { exportSnapshot } from "../src/integration/snapshot.js";
import { validateSnapshot } from "../src/exports/snapshot.js";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FieldService } from "../src/service.js";
import { createApp } from "../src/api.js";
import { WorkPackageStore } from "../src/work-packages/store.js";
import { createIntegratedServices } from "../src/integration/runtime.js";
import { integratedInput } from "./fixtures/integrated-package.js";
import type { ChoiceClient } from "@field-agent/workflow";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup(choice?: ChoiceClient) {
  const dir = mkdtempSync(join(tmpdir(), "real-pi-integration-"));
  const field = new FieldService(dir);
  const events: string[] = [];
  const integrated = createIntegratedServices(
    new WorkPackageStore(field.store.db),
    dir,
    { choice, onEvent: (_id, e) => events.push(e.type) },
  );
  const app = createApp(field, {
    token: "integration-test-token",
    workPackages: integrated.packages,
    workPackageExports: integrated.exports,
    workPackageDetails: integrated.details,
  });
  cleanup.push(() => {
    integrated.packages.close();
    field.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...integrated, field, events, app };
}
async function create(
  t: ReturnType<typeof setup>,
  scenario: 2 | 3 = 2,
  open = false,
  change?: (input: ReturnType<typeof integratedInput>) => void,
) {
  const s = t.packages.create({
    projectId: "test-project",
    title: "input",
    intent: scenario === 2 ? "prepare_from_drawing" : "adapt_to_site",
  });
  const asset = await t.packages.upload(
    s.id,
    Buffer.from("%PDF-1.4\nfixture"),
    "application/pdf",
    "drawing.pdf",
  );
  return t.packages.edit(s.id, {
    expectedRevision: 1,
    patch: (() => {
      const input = integratedInput(asset.id, scenario, open);
      change?.(input);
      return input;
    })(),
  });
}
async function run(t: ReturnType<typeof setup>, id: string, goal?: string) {
  const s = t.packages.get(id);
  const response = await t.app.request(`/api/work-packages/${id}/runs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expectedRevision: s.inputRevision,
      goal: goal ?? s.intent,
    }),
  });
  expect(response.status).toBe(202);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const current = t.packages.get(id);
    if (current.run?.status !== "running") return current;
  }
  throw new Error("Run did not stop");
}
it("runs real Pi for a drawing-only open spool and exports the authoritative saved outputs", async () => {
  const t = setup(),
    s = await create(t, 2, true);
  const result = await run(t, s.id);
  expect(
    result.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("completed");
  const d = t.detailStore.get(s.id)!.details[0];
  expect(d.fabrication.cuts.map((c) => c.cutLength.value)).toEqual([
    0.5762625, 0.4238625,
  ]);
  expect(d.fabrication.operations.every((o) => o.status === "planned")).toBe(
    true,
  );
  expect(d.profile?.profile).toBe("drawing_preparation");
  expect(d.profile?.project.localChange).toBeUndefined();
  expect(d.profile?.required.length).toBeGreaterThan(5);
  expect(t.events).toContain("tool_execution_end");
  validateSnapshot(
    exportSnapshot(t.packages.get(s.id), t.detailStore.get(s.id)!)!,
  );
  const exported = await run(t, s.id, "export_selected_package");
  expect(
    exported.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("completed");
  expect(exported.outputs.artifacts).toHaveLength(4);
  const pdf = exported.outputs.artifacts.find((a) => a.kind === "pdf")!;
  expect(
    t.packages.artifact(s.id, pdf.id).bytes.subarray(0, 5).toString(),
  ).toBe("%PDF-");
  const csv = exported.outputs.artifacts.find((a) => a.kind === "cut_csv")!;
  expect(t.packages.artifact(s.id, csv.id).bytes.toString()).toContain(
    "0.5762625",
  );
  t.packages.edit(s.id, {
    expectedRevision: exported.inputRevision,
    patch: { title: "changed" },
  });
  expect(() => t.packages.artifact(s.id, pdf.id)).toThrow("stale_artifact");
});
it("generates two real CPVC alternatives without a supplied reroute, waits for human selection, and preserves fixed-end limits", async () => {
  const t = setup(),
    s = await create(t, 3);
  const result = await run(t, s.id);
  expect(
    result.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("waiting_input");
  expect(result.outputs.candidates?.candidates).toHaveLength(2);
  expect(result.selectedPlan).toBeNull();
  const state = t.detailStore.get(s.id)!;
  expect(state.details).toHaveLength(3);
  expect(
    state.details[1].fabrication.cuts.reduce(
      (n, c) => n + c.cutLength.value!,
      0,
    ),
  ).toBeCloseTo(12.4333, 8);
  expect(
    state.details[2].fabrication.cuts.reduce(
      (n, c) => n + c.cutLength.value!,
      0,
    ),
  ).toBeCloseTo(12.9333, 8);
  for (const d of state.details.slice(1)) {
    expect(d.profile?.profile).toBe("site_adaptation");
    expect(d.profile?.project.localChange).toBeDefined();
    expect(d.profile?.required.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "SFFD_LOCAL_CHANGE_APPROVED_BASELINE_V1",
        "SFFD_LOCAL_CHANGE_ROUTE_GEOMETRY_V1",
        "LOCAL_CHANGE_STRAIGHT_PIPE_DUCT_ENVELOPE_V1",
        "NFPA13_LOCAL_HEAD_SPACING_SOURCE_PENDING_V1",
        "NFPA13_LOCAL_OBSTRUCTION_SOURCE_PENDING_V1",
        "SFFD_AB204_HYDRAULIC_RECALC_I22A2_V1",
        "ASSEMBLY_CONDITIONS",
      ]),
    );
    expect(
      d.profile?.checks.find(
        (c) => c.id === "NFPA13_LOCAL_HEAD_SPACING_SOURCE_PENDING_V1",
      )?.state,
    ).toBe("source_pending");
    expect(
      d.fabrication.operations.some(
        (o) => o.code === "resolve_connection" && o.status === "unsupported",
      ),
    ).toBe(true);
    expect(
      d.profile?.checks.find((c) => c.id === "ASSEMBLY_CONDITIONS")?.status,
    ).toBe("unknown");
  }
  t.packages.select(s.id, {
    expectedRevision: result.inputRevision,
    planId: result.outputs.candidates!.candidates[0].plan.id,
  });
  const selected = await run(t, s.id);
  expect(
    selected.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("completed");
  validateSnapshot(
    exportSnapshot(t.packages.get(s.id), t.detailStore.get(s.id)!)!,
  );
  const exported = await run(t, s.id, "export_selected_package");
  expect(
    exported.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("completed");
  expect(exported.outputs.artifacts).toHaveLength(4);
});
it("uses a recorded Choice between real missing questions, persists wait/answer and resumes in a fresh Pi Agent", async () => {
  let calls = 0;
  const choice: ChoiceClient = {
    async choose(request) {
      calls++;
      const ids = Object.keys(request.questions.next_action.criteria);
      expect(ids).toEqual([
        "request_input:workAreaAccess",
        "request_input:curePlan",
        "needs_clarification",
      ]);
      return {
        inputRevision: request.state.inputRevision,
        configVersion: request.state.configVersion,
        response: {
          model: request.model,
          answers: {
            next_action: {
              type: "choice",
              choice: "request_input:workAreaAccess",
              confidence: 0.8,
              probabilities: {
                "request_input:workAreaAccess": 0.8,
                "request_input:curePlan": 0.15,
                needs_clarification: 0.05,
              },
            },
          },
        },
      };
    },
  };
  const t = setup(choice),
    s = await create(t, 2, true);
  t.packages.edit(s.id, {
    expectedRevision: s.inputRevision,
    patch: {
      detailing: s.detailing.filter(
        (f) => !["workAreaAccess", "curePlan"].includes(f.field),
      ),
    },
  });
  const first = await run(t, s.id);
  expect(first.run?.status).toBe("waiting_input");
  expect(calls).toBe(1);
  expect(first.outputs.results.length).toBeGreaterThan(0);
  expect(t.detailStore.get(s.id)?.latestRun?.latestDecision?.source).toBe(
    "jev",
  );
  t.packages.answer(s.id, {
    expectedRevision: first.inputRevision,
    requestId: first.outputs.requests.at(-1)!.id,
    value: null,
    unavailableReason: "Not available today",
  });
  const second = await run(t, s.id);
  expect(second.run?.id).not.toBe(first.run?.id);
  expect(second.run?.status).toBe("waiting_input");
  expect(second.outputs.requests.at(-1)?.question).toContain("cure");
  expect(
    t.detailStore
      .get(s.id)!
      .details[0].fabrication.operations.some(
        (o) => o.status === "needs_confirmation",
      ),
  ).toBe(true);
});
it("keeps missing datum cuts null without losing known counts or centerline", async () => {
  const t = setup(),
    s = await create(t);
  t.packages.edit(s.id, {
    expectedRevision: s.inputRevision,
    patch: { detailing: s.detailing.filter((f) => f.field !== "datum.start") },
  });
  const result = await run(t, s.id);
  expect(
    result.run?.status,
    JSON.stringify(t.detailStore.get(s.id)?.latestRun),
  ).toBe("completed");
  const d = t.detailStore.get(s.id)!.details[0];
  expect(d.fabrication.cuts[0].cutLength.value).toBeNull();
  expect(d.fabrication.cuts[0].centerline.value).toBe(10);
  expect(d.fabrication.materials[0].quantity.value).toBe(1);
  expect(d.fabrication.materials[0].cutLength?.value).toBeNull();
});
it.each(["cancel", "edit"] as const)(
  "prevents late Choice publication after %s and reuses only matching starts",
  async (mode) => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => (entered = r));
    const choice: ChoiceClient = {
      async choose(request) {
        entered();
        await new Promise<void>((r) => (release = r));
        throw new Error("late unavailable response");
      },
    };
    const t = setup(choice),
      s = await create(t, 2, true, (input) => {
        input.detailing = input.detailing.filter(
          (f) => !["workAreaAccess", "curePlan"].includes(f.field),
        );
      });
    const first = t.packages.start(s.id, {
      expectedRevision: s.inputRevision,
      goal: s.intent,
    });
    const duplicate = t.packages.start(s.id, {
      expectedRevision: s.inputRevision,
      goal: s.intent,
    });
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.reused).toBe(true);
    expect(() =>
      t.packages.start(s.id, {
        expectedRevision: s.inputRevision,
        goal: "export_selected_package",
      }),
    ).toThrow("active_run_goal_conflict");
    await waiting;
    const before = t.detailStore.get(s.id)!;
    expect(before.details.length).toBeGreaterThan(0);
    if (mode === "cancel") t.packages.cancel(s.id, first.run.id);
    else
      t.packages.edit(s.id, {
        expectedRevision: s.inputRevision,
        patch: { title: "edited during Choice" },
      });
    release();
    await new Promise((r) => setTimeout(r, 20));
    const after = t.packages.get(s.id);
    expect(after.run?.status).toBe(
      mode === "cancel" ? "cancelled" : "interrupted",
    );
    expect(after.outputs.requests).toHaveLength(0);
    expect(t.detailStore.get(s.id)?.latestRun?.question).toBeUndefined();
    if (mode === "edit")
      expect(after.freshness.results.every((r) => !r.current)).toBe(true);
  },
);
it("keeps unsupported product cuts unresolved and retains context without adding purchase items", async () => {
  const t = setup(),
    s = await create(t, 2, false, (input) => {
      input.baselinePlan!.entities.find((e) => e.kind === "pipe")!.productId =
        "unlisted-pipe";
    });
  const result = await run(t, s.id);
  expect(result.run?.status).toBe("completed");
  const d = t.detailStore.get(s.id)!.details[0];
  expect(d.fabrication.cuts[0].cutLength.value).toBeNull();
  expect(d.fabrication.materials[0].quantity.value).toBe(1);
  expect(d.fabrication.operations.some((o) => o.status === "unsupported")).toBe(
    true,
  );
  const p = await create(t, 3, false, (input) => {
    input.baselinePlan!.entities.push({
      id: "protected-head",
      kind: "head",
      productId: "TY3231",
      ports: [],
    });
    input.scope!.includedEntityIds.push("protected-head");
  });
  const blocked = await run(t, p.id);
  expect(blocked.run?.status).toBe("waiting_input");
  expect(blocked.outputs.candidates?.candidates).toHaveLength(2);
  for (const c of blocked.outputs.candidates!.candidates) {
    expect(c.plan.entities.find(e => e.id === "protected-head")).toEqual(p.baselinePlan!.entities.find(e => e.id === "protected-head"));
  }
  expect(blocked.outputs.results.every(r => !r.materials.some(m => m.entityIds.includes("protected-head")))).toBe(true);
  expect(blocked.outputs.results[0].gaps.some(g => g.id === "protected-context")).toBe(true);
});
it("blocks an empty search and exposes required checks plus raw source-bound detail through the authenticated API", async () => {
  const t = setup(),
    s = await create(t, 3, false, (input) => {
      input.detailing = input.detailing.filter(
        (f) => f.field !== "workEnvelope.min.x",
      );
    });
  const result = await run(t, s.id);
  expect(result.run?.status).toBe("blocked");
  expect(result.outputs.candidates?.candidates).toHaveLength(0);
  const good = await create(t, 2, true);
  await run(t, good.id);
  const path = `/api/work-packages/${good.id}/detail`;
  expect((await t.app.request(path)).status).toBe(401);
  const response = await t.app.request(path, {
    headers: { Authorization: "Bearer integration-test-token" },
  });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.current).toBe(true);
  expect(data.state.details[0].profile.required).toEqual(
    data.state.details[0].profile.checks.map(
      (c: { id: string; subjectIds: string[] }) => ({
        id: c.id,
        subjectIds: c.subjectIds,
      }),
    ),
  );
  expect(data.exportBinding.outputVersion).toBe(data.state.details[0].id);
});

it("runs an independently created rotated interval with retained context through selection, export and invalidation", async () => {
  const t = setup();
  const s = await create(t, 3, false, input => {
    const fixture = adaptationFixture(31, true);
    input.baselinePlan = fixture.baselinePlan;
    input.scope = fixture.scope;
    input.siteFacts = fixture.siteFacts;
    input.detailing = fixture.detailing;
    input.changeRequest = fixture.changeRequest;
  });
  const generated = await run(t, s.id);
  expect(generated.run?.status, JSON.stringify(t.detailStore.get(s.id)?.latestRun)).toBe("waiting_input");
  expect(generated.outputs.candidates?.candidates).toHaveLength(2);
  const candidate = generated.outputs.candidates!.candidates[0];
  t.packages.select(s.id, { expectedRevision: generated.inputRevision, planId: candidate.plan.id });
  const selected = await run(t, s.id);
  expect(selected.run?.status).toBe("completed");
  const snapshot = exportSnapshot(selected, t.detailStore.get(s.id)!)!;
  validateSnapshot(snapshot);
  expect(snapshot.selectedPlan.context?.find(c => c.id === "terminal")?.kind).toBe("head");
  expect(snapshot.cuts).toHaveLength(5);
  expect(snapshot.cuts[0].length).toBeNull();
  expect(snapshot.materials.some(m => m.subjectIds.includes("terminal"))).toBe(false);
  const start = s.baselinePlan!.entities.find(e => e.id === "pipe")!.ports[0].position!;
  expect(snapshot.selectedPlan.segments[0].from[0]).toBeCloseTo(start.x, 8);
  expect(snapshot.selectedPlan.segments[0].from[1]).toBeCloseTo(start.y, 8);
  const exported = await run(t, s.id, "export_selected_package");
  expect(exported.run?.status).toBe("completed");
  expect(exported.outputs.artifacts).toHaveLength(4);
  const artifact = exported.outputs.artifacts[0];
  const changed = t.packages.edit(s.id, { expectedRevision: exported.inputRevision, patch: { detailing: exported.detailing.map(f => f.field === "duct.max.y" ? { ...f, value: 2 } : f) } });
  expect(changed.baselinePlan).toEqual(s.baselinePlan);
  expect(() => t.packages.artifact(s.id, artifact.id)).toThrow("stale_artifact");
  expect(() => t.packages.select(s.id, { expectedRevision: changed.inputRevision, planId: candidate.plan.id })).toThrow("stale_candidates");
});

it("persists FS-01 steel alternatives with unknown physical closure and no SF/CPVC default", async () => {
  const t = setup(), s = await create(t, 3, false, input => Object.assign(input, fs01Adaptation(input.sourceDrawing!.assetId)));
  const generated = await run(t, s.id);
  expect(generated.outputs.candidates?.candidates, JSON.stringify(t.detailStore.get(s.id)?.latestRun)).toHaveLength(2);
  const details = t.detailStore.get(s.id)!.details;
  expect(details).toHaveLength(3);
  for (const d of details) {
    expect(d.input.nodes.filter(n => n.datum === "scope_interface")).toHaveLength(2);
    expect(d.fabrication.cuts.every(c => c.cutLength.value === null)).toBe(true);
    expect(d.fabrication.materials.some(m => m.productId?.startsWith("spears/"))).toBe(false);
    expect(d.profile?.project.basis).toBeUndefined();
  }
  expect(generated.baselinePlan).toEqual(s.baselinePlan);
});
