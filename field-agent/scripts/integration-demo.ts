import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const { serve } = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
)(
  "@hono/node-server",
) as typeof import("../apps/server/node_modules/@hono/node-server/dist/index.js");
import { FieldService } from "../apps/server/src/service.js";
import { WorkPackageStore } from "../apps/server/src/work-packages/store.js";
import {
  type Detail,
  createIntegratedServices,
} from "../apps/server/src/integration/runtime.js";
import { createApp } from "../apps/server/src/api.js";
import { integratedInput } from "../apps/server/test/fixtures/integrated-package.js";
const output = resolve(process.argv[2] ?? ".data/integration-demo");
mkdirSync(output, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "integration-demo-")),
  field = new FieldService(data);
const integrated = createIntegratedServices(
  new WorkPackageStore(field.store.db),
  data,
);
const token = "local-integration-demo-only";
const app = createApp(field, {
  token,
  workPackages: integrated.packages,
  workPackageExports: integrated.exports,
  workPackageDetails: integrated.details,
});
let server: ReturnType<typeof serve>;
const address = await new Promise<{ port: number }>((resolve) => {
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, resolve);
});
const base = `http://127.0.0.1:${address.port}/api/work-packages`;
const request = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  return response.json();
};
async function run(id: string, goal: string) {
  let s = await request(`/${id}`);
  await request(`/${id}/runs`, "POST", {
    expectedRevision: s.inputRevision,
    goal,
  });
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 10));
    s = await request(`/${id}`);
    if (s.run.status !== "running") {
      if (!["completed", "waiting_input", "blocked"].includes(s.run.status))
        throw new Error(JSON.stringify(s.run));
      return s;
    }
  }
  throw new Error("Run timeout");
}
try {
  const summaries = [];
  for (const scenario of [2, 3] as const) {
    const created = await request("", "POST", {
      projectId: "integration-demo",
      title: "fixture",
      intent: scenario === 2 ? "prepare_from_drawing" : "adapt_to_site",
    });
    const form = new FormData();
    form.set(
      "file",
      new Blob(
        [
          Buffer.from(
            "%PDF-1.4\nExplicit acceptance fixture, not a real drawing",
          ),
        ],
        { type: "application/pdf" },
      ),
      "fixture.pdf",
    );
    const assetResponse = await fetch(`${base}/${created.id}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!assetResponse.ok) throw new Error("Upload failed");
    const asset = await assetResponse.json();
    let s = await request(`/${created.id}`, "PATCH", {
      expectedRevision: 1,
      patch: integratedInput(asset.id, scenario, scenario === 2),
    });
    s = await run(s.id, s.intent);
    if (scenario === 3) {
      await request(`/${s.id}/selection`, "POST", {
        expectedRevision: s.inputRevision,
        planId: s.outputs.candidates.candidates[0].plan.id,
      });
      s = await run(s.id, s.intent);
    }
    s = await run(s.id, "export_selected_package");
    for (const artifact of s.outputs.artifacts) {
      const response = await fetch(
        `${base}/${s.id}/artifacts/${artifact.id}/download`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("Artifact download failed");
      writeFileSync(
        join(
          output,
          `scenario-${scenario}-${artifact.kind}.${artifact.kind === "pdf" ? "pdf" : artifact.kind === "manifest" ? "json" : "csv"}`,
        ),
        Buffer.from(await response.arrayBuffer()),
      );
    }
    const detail = await request(`/${s.id}/detail`);
    writeFileSync(
      join(output, `scenario-${scenario}-detail.json`),
      JSON.stringify(detail, null, 2),
    );
    summaries.push({
      scenario,
      runStatus: s.run.status,
      inputRevision: s.inputRevision,
      artifacts: s.outputs.artifacts.length,
      plans: detail.state.details.map((d: Detail) => ({
        id: d.plan.id,
        cuts: d.fabrication.cuts.map((c) => c.cutLength.value),
        requiredChecks: d.profile?.required.length,
        assemblyPlanned: d.fabrication.operations.every(
          (o) => o.status === "planned",
        ),
      })),
    });
  }
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        scope:
          "Real loopback HTTP API, actual Pi and domain engines; invented site confirmations. No live JEV or browser acceptance.",
        summaries,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, summaries }, null, 2));
} finally {
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  integrated.packages.close();
  field.store.close();
}
