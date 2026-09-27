/** Explicit synthetic input seed for local browser QA; never publishes generated results. */
import sharp from "sharp";
import { adaptationFixture } from "../test/fixtures/adaptation-package.js";
const url = process.env.FIELD_AGENT_URL ?? "http://127.0.0.1:4312";
const token = process.env.FIELD_AGENT_TOKEN;
if (!token) throw new Error("Set FIELD_AGENT_TOKEN for your local test server");
const headers = { Authorization: `Bearer ${token}` };
async function json(path: string, method: string, body?: unknown) {
  const r = await fetch(`${url}/api/work-packages${path}`, { method, headers: { ...headers, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}
const pkg = await json("", "POST", { projectId: "issue12-synthetic-qa", intent: "adapt_to_site", title: "SAMPLE: rotated interval and retained L-branch" });
const picture = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="white"/><text x="30" y="50" font-size="24">SAMPLE INPUT - NOT FIELD EVIDENCE</text><path d="M50 220 L650 220 L650 90" fill="none" stroke="black" stroke-width="5"/><text x="30" y="280" font-size="18">Synthetic CPVC geometry control, no construction approval</text></svg>')).png().toBuffer();
const form = new FormData(); form.append("file", new Blob([new Uint8Array(picture)], { type: "image/png" }), "synthetic-input.png");
const upload = await fetch(`${url}/api/work-packages/${pkg.id}/assets`, { method: "POST", headers, body: form });
if (!upload.ok) throw new Error(await upload.text());
const asset = await upload.json();
const { baselinePlan, scope, detailing, siteFacts, changeRequest, sourceDrawing } = adaptationFixture(31, true);
sourceDrawing!.assetId = asset.id; sourceDrawing!.approval = "unreviewed";
for (const f of [...detailing, ...siteFacts]) f.source.description = `SAMPLE: ${f.source.description}`;
await json(`/${pkg.id}`, "PATCH", { expectedRevision: pkg.inputRevision, patch: { baselinePlan, scope, detailing, siteFacts, changeRequest, sourceDrawing } });
console.log(`${url}/p/${pkg.id}`);
