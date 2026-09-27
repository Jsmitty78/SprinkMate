import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  evaluateLocalPlanGeometry,
  adaptationInterval,
  type WorkPackageSnapshot,
  type PackageResult,
  type PackagePlan,
  type CandidateSet as ApiCandidates,
} from "@field-agent/core";
import {
  deriveWorkPackage,
  compareWorkPackages,
  fabricationCatalog,
  type FabricationOutput,
  type FabricationInput,
} from "@field-agent/fabrication";
import {
  generateCandidates,
  createLocalGeometryPort,
  toFabricationInput,
  type CandidateSet,
  type Plan,
} from "@field-agent/planning";
import {
  WorkflowRunner,
  JevHttpClient,
  ChoiceFailure,
  type ChoiceClient,
  type DomainPort,
  type OutputRef,
  type RunRecord,
  type WorkSnapshot,
} from "@field-agent/workflow";
import {
  WorkPackageService,
  type WorkPackageRunner,
} from "../work-packages/service.js";
import { WorkPackageStore } from "../work-packages/store.js";
import { WorkPackageExports } from "../exports/service.js";
import {
  fabricationInput,
  planningPlan,
  generationInput,
  apiCandidate,
  candidatePackage,
  safe,
  value,
} from "./model.js";
import { evaluateProfile, type ProfileOutput } from "./profiles.js";
import { exportSnapshot } from "./snapshot.js";

export const INTEGRATION_VERSION = "scenario-integration-3-steel-interval";
export interface Detail {
  id: string;
  input: FabricationInput;
  plan: Plan;
  fabrication: FabricationOutput;
  profile?: ProfileOutput;
  delta?: ReturnType<typeof compareWorkPackages>;
}
export interface IntegratedState {
  inputRevision: number;
  configVersion: string;
  refs: OutputRef[];
  candidates?: CandidateSet;
  details: Detail[];
  acknowledgedQuestions?: string[];
  latestRun?: RunRecord;
}
export class IntegrationStore {
  constructor(private store: WorkPackageStore) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS work_package_detail (package_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  get(id: string): IntegratedState | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM work_package_detail WHERE package_id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  save(id: string, state: IntegratedState) {
    this.store.db
      .prepare(
        "INSERT INTO work_package_detail(package_id,data) VALUES(?,?) ON CONFLICT(package_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(state));
  }
}
const geometry = createLocalGeometryPort(evaluateLocalPlanGeometry);
function summary(d: Detail, api: PackagePlan): PackageResult {
  const f = d.fabrication,
    entities = new Set(api.entities.map((e) => e.id));
  const subjects = (ids: string[]) => ids.filter((id) => entities.has(id));
  const jointRef = (id: string) => {
    const joint = f.joints.find((j) => j.id === id)!;
    const pipe = api.entities.find((e) => e.id === joint.pieceId)!;
    const port = pipe.ports[joint.end === "start" ? 0 : 1].id;
    const connection = api.connections.find((c) =>
      [c.from, c.to].some(
        (e) => e.entityId === joint.pieceId && e.portId === port,
      ),
    );
    if (!connection)
      throw new Error("Assembly joint does not resolve in the saved plan");
    return connection.id;
  };
  const q = (m: FabricationOutput["cuts"][number]["cutLength"]) =>
    m.value === null
      ? {
          value: null,
          unit: m.unit,
          reason: m.reasons.join("; ") || "Unresolved",
          basis: "unknown" as const,
        }
      : {
          value: m.value,
          unit: m.unit,
          reason: null,
          basis:
            m.basis === "proposed_inputs"
              ? ("proposed_inputs" as const)
              : ("confirmed_inputs" as const),
        };
  return {
    id: d.id,
    inputRevision: f.inputRevision,
    configVersion: f.configVersion,
    planId: f.planId,
    materials: f.materials.map((m) => ({
      id: safe(m.id),
      entityIds: subjects(m.entityIds),
      description: m.kind === "pipe" ? `${m.productId ?? "Unselected pipe"} (modeled spans; not purchasing stock)` : m.productId ?? m.kind,
      quantity: q(m.quantity),
    })),
    cuts: f.cuts.map((c) => ({
      id: safe(`cut-${c.pieceId}`),
      pieceId: c.pieceId,
      sourceEntityIds: [c.pieceId],
      length: q(c.cutLength),
    })),
    assembly: f.operations.map((o) => ({
      id: safe(o.id),
      step: o.number,
      pieceIds: o.pieceIds,
      jointIds: o.jointIds.map(jointRef),
      instruction: o.instruction,
      procedureRef: o.sourceIds.join(",") || null,
      unresolved: o.reasons,
    })),
    evaluations: (d.profile?.checks ?? []).map((c) => ({
      id: safe(c.id),
      subjectIds: subjects(c.subjectIds),
      status: c.status,
      reason: c.reason,
      sourceRefs: c.sourceRefs,
    })),
    gaps: [...(f.intent === "adapt_to_site" ? [{ id: "protected-context", subjectIds: [], reason: "Quantities cover only the active interval. Remaining source geometry is retained context, not purchase material. Context clearance, support adequacy, fixed-end closure, physical dimensions and hydraulics remain unresolved." }] : []), ...f.gaps.map((g, i) => ({
      id: `gap-${i}`,
      subjectIds: subjects([g.subjectId]),
      reason: g.reason,
    }))],
  };
}
function derive(
  s: WorkPackageSnapshot,
  input: FabricationInput,
  plan: Plan,
): Detail {
  const fabrication = deriveWorkPackage(input, fabricationCatalog(s.configVersion));
  const calculated = geometry({
    plan,
    proposedNodeIds: input.nodes
      .filter((n) => n.position.status === "proposed")
      .map((n) => n.id),
    proposedFittingIds: plan.fittings
      .filter((f) => !f.kind.confirmed)
      .map((f) => f.id),
  });
  if (!calculated.ok) throw new Error(calculated.reason);
  // The rule engine owns centerline-datum acceptance. The physical open-spool engine remains separately labeled.
  for (const c of fabrication.cuts) {
    const segment = plan.segments.find((p) => p.id === c.pieceId)!;
    const physical = [
      segment.cutEndDatumAtStart,
      segment.cutEndDatumAtEnd,
    ].some((d) => d.confirmed && d.value === "physical_pipe_end");
    if (
      [segment.cutEndDatumAtStart, segment.cutEndDatumAtEnd].some(
        (d) =>
          !d.confirmed ||
          d.value === null ||
          !d.evidenceIds.length ||
          d.source === "model",
      ) ||
      (!physical &&
        calculated.result.segments.find((p) => p.segmentId === c.pieceId)
          ?.cutLengthM === null)
    ) {
      c.cutLength = {
        ...c.cutLength,
        value: null,
        basis: "unknown",
        reasons: [
          ...c.cutLength.reasons,
          "Endpoint datum is missing, unconfirmed or unsupported",
        ],
      };
      for (const o of fabrication.operations.filter((o) =>
        o.pieceIds.includes(c.pieceId),
      )) {
        if (o.status === "planned") o.status = "needs_confirmation";
        o.reasons.push("Resolve endpoint datum before fabrication");
      }
    }
  }
  for (const m of fabrication.materials.filter((m) => m.kind === "pipe")) {
    const rows = fabrication.cuts.filter((c) => c.productId === m.productId);
    if (rows.some((c) => c.cutLength.value === null)) {
      m.cutLength = {
        value: null,
        unit: "m",
        basis: "unknown",
        reasons: rows.flatMap((c) => c.cutLength.reasons),
        evidenceIds: [],
      };
      m.status = "unresolved";
    }
  }
  return { id: randomUUID(), input, plan, fabrication };
}
export function createIntegratedServices(
  store: WorkPackageStore,
  directory: string,
  options: {
    pdfFontPath?: string;
    choice?: ChoiceClient;
    onEvent?: ConstructorParameters<typeof WorkflowRunner>[0]["onEvent"];
    configVersion?: string;
  } = {},
) {
  const configVersion = options.configVersion ?? INTEGRATION_VERSION,
    detailStore = new IntegrationStore(store);
  const choice =
    options.choice ??
    (process.env.TYPESAFE_API_KEY
      ? new JevHttpClient(process.env.TYPESAFE_API_KEY)
      : {
          async choose() {
            throw new ChoiceFailure("TYPESAFE_API_KEY_not_configured");
          },
        });
  let packages: WorkPackageService;
  const exports = new WorkPackageExports({
    directory: join(directory, "exports"),
    pdf: {
      fontPath:
        options.pdfFontPath ??
        process.env.FIELD_AGENT_PDF_FONT ??
        [
          "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ].find(existsSync),
    },
    loadCurrent: async (id) => {
      const s = packages.get(id),
        state = detailStore.get(id);
      if (!state) return null;
      return exportSnapshot(s, state);
    },
  });
  const runner: WorkPackageRunner = {
    async execute(context) {
      const initial = context.snapshot,
        prior = detailStore.get(initial.id);
      let state: IntegratedState =
        prior &&
        prior.inputRevision === initial.inputRevision &&
        prior.configVersion === initial.configVersion
          ? structuredClone(prior)
          : {
              inputRevision: initial.inputRevision,
              configVersion: initial.configVersion,
              refs: [],
              details: [],
              ...(prior?.candidates ? { candidates: prior.candidates } : {}),
            };
      state.acknowledgedQuestions = [...(prior?.acknowledgedQuestions ?? [])];
      if (
        prior?.latestRun?.question &&
        initial.answers.some(
          (a) =>
            a.requestId ===
            safe(
              `${initial.id}/${prior.latestRun!.inputRevision}/${prior.latestRun!.question!.id}`,
            ),
        )
      )
        state.acknowledgedQuestions.push(prior.latestRun.question.id);
      const current = () => packages.get(initial.id);
      const guard = () => {
        const s = current();
        return (
          !context.signal.aborted &&
          s.run?.id === context.run.id &&
          s.run.status === "running" &&
          s.inputRevision === initial.inputRevision &&
          s.configVersion === initial.configVersion
        );
      };
      const save = () => {
        if (!guard()) return false;
        detailStore.save(initial.id, state);
        return true;
      };
      const requestId = (key: string) =>
        safe(`${initial.id}/${initial.inputRevision}/${key}`);
      const domain: DomainPort = {
        read() {
          const s = current();
          const base = s.baselinePlan;
          const gaps: WorkSnapshot["gaps"] = [];
          if (
            state.candidates?.inputRevision === s.inputRevision &&
            !state.candidates.candidates.length
          )
            gaps.push({
              id: "no-candidate",
              description:
                state.candidates.reasons.map((r) => r.message).join("; ") ||
                "No candidate in the bounded search",
              blocks: ["generate_change_candidates"],
            });
          if (!s.sourceDrawing || !base || !s.scope)
            gaps.push({
              id: "drawing",
              description:
                "Supply the source drawing, structured run and work area",
              blocks: ["prepare_drawing_model"],
            });
          if (s.intent === "adapt_to_site" && base && s.scope) {
            try { adaptationInterval(s); } catch (error) {
              gaps.push({ id: "unsupported-interval", description: error instanceof Error ? error.message : String(error), blocks: ["prepare_drawing_model", "generate_change_candidates"] });
            }
          }
          const addQuestion = (key: string, text: string, order: number) => {
            const answered = s.outputs.requests.find(
              (r) => r.id === requestId(key),
            );
            if (answered && s.answers.some((a) => a.requestId === answered.id))
              return;
            gaps.push({
              id: key,
              description: text,
              blocks: [],
              question: {
                id: key,
                text,
                kind: "fact",
                subjectId: base?.id ?? "drawing",
                order,
              },
            });
          };
          // Answers acknowledge unavailability; only explicit fact edits confirm engineering inputs.
          for (const [key, text, order] of [
            [
              "workAreaAccess",
              "Confirm work-area access through a fact edit, or answer unavailable.",
              0,
            ],
            [
              "curePlan",
              "Provide the reviewed cure plan through a fact edit, or answer unavailable.",
              1,
            ],
          ] as const) {
            if (key === "curePlan" && !base?.entities.some(e => fabricationCatalog(s.configVersion).products.some(p => p.id === e.productId && p.connection === "cpvc_socket_solvent"))) continue;
            if (
              value(s, key).status === "unknown" &&
              !state.acknowledgedQuestions?.includes(key) &&
              !s.answers.some((a) =>
                s.outputs.requests.some(
                  (r) => r.id === a.requestId && r.question === text,
                ),
              )
            )
              addQuestion(key, text, order);
          }
          return {
            id: s.id,
            intent: s.intent,
            inputRevision: s.inputRevision,
            configVersion: s.configVersion,
            drawingId: s.sourceDrawing?.drawingId ?? "drawing",
            baselinePlanId: base?.id ?? "baseline",
            changeRequestId: s.changeRequest?.id,
            selectedPlanId: s.selectedPlan?.id,
            outputs: structuredClone(state.refs),
            gaps,
            evidenceCandidates: [],
          };
        },
        async execute(action, execution) {
          if (execution.signal.aborted) throw new Error("cancelled");
          const s = current();
          let payload: unknown;
          if (action.operation === "prepare_drawing_model") {
            fabricationInput(s, s.baselinePlan!);
            payload = null;
          } else if (action.operation === "generate_change_candidates") {
            const result = generateCandidates(generationInput(s), geometry);
            result.candidates = result.candidates.map((c) => {
              const plan = apiCandidate(c.plan);
              return {
                ...c,
                id: plan.id,
                plan,
                proposedNodeIds: plan.nodes
                  .filter((n) => !n.position.confirmed)
                  .map((n) => n.id),
                proposedFittingIds: plan.fittings
                  .filter((f) => !f.kind.confirmed)
                  .map((f) => f.id),
              };
            });
            payload = result;
          } else if (action.operation === "derive_work_package") {
            const baseInput = fabricationInput(s, s.baselinePlan!),
              basePlan = planningPlan(s, baseInput),
              base = derive(s, baseInput, basePlan);
            const wanted = s.selectedPlan
              ? state.candidates?.candidates.filter(
                  (c) => c.id === s.selectedPlan!.id,
                )
              : s.intent === "adapt_to_site"
                ? state.candidates?.candidates
                : [];
            if (s.selectedPlan && !wanted?.length)
              throw new Error("Selected plan calculation record missing");
            const details = [base];
            for (const original of wanted ?? []) {
              const c = structuredClone(original);
              c.plan.ducts = generationInput(s).baseline.ducts;
              const input: FabricationInput = toFabricationInput(
                { ...s, packageId: s.id, plan: c.plan, status: "proposed" },
                {
                  baselinePlanId: s.baselinePlan!.id,
                  sourceDrawing: baseInput.sourceDrawing,
                  selectedPlanId: s.selectedPlan?.id ?? null,
                  siteEvidenceIds: baseInput.siteEvidenceIds,
                  evidence: baseInput.evidence,
                  subassemblyId: "run",
                  jointLocation: "field",
                  disposition: "new",
                  assemblyConditions: baseInput.assemblyConditions,
                },
              );
              // Retain source-only station semantics; a generated route cannot confirm a physical end.
              for (const node of input.nodes) if (baseInput.nodes.some(n => n.id === node.id && n.datum === "scope_interface")) {
                node.datum = "scope_interface";
                delete node.netCutOffset;
              }
              const d = derive(s, input, c.plan);
              d.delta = compareWorkPackages(base.fabrication, d.fabrication);
              details.push(d);
            }
            payload = details;
          } else if (action.operation === "evaluate_work_package") {
            payload = state.details.map((d) => ({
              ...d,
              id: randomUUID(),
              profile: evaluateProfile(
                s,
                d.input,
                d.fabrication,
                d.plan,
                state.details[0].plan,
              ),
            }));
          } else if (action.operation === "compare_candidates") {
            payload = state.details
              .filter((d) => d.delta)
              .map((d) => ({ planId: d.plan.id, delta: d.delta }));
          } else if (action.operation === "export_work_package") {
            const snapshot = exportSnapshot(s, state);
            if (!snapshot) throw new Error("No current selected output");
            const manifest = await exports.create(s.id, snapshot.binding);
            const files = [];
            for (const name of [
              "work-package.pdf",
              "bom.csv",
              "cut-list.csv",
              "manifest.json",
            ] as const)
              files.push(await exports.download(s.id, manifest.exportId, name));
            payload = files;
          } else throw new Error(`Unsupported operation ${action.operation}`);
          return {
            summary: `${action.operation} produced current domain outputs`,
            payload,
          };
        },
        commit(action, result) {
          if (!guard()) return false;
          const s = current();
          const ref = (
            kind: OutputRef["kind"],
            subjectId = action.subjectId,
          ) => {
            state.refs.push({
              id: randomUUID(),
              kind,
              subjectId,
              inputRevision: s.inputRevision,
              configVersion: s.configVersion,
            });
          };
          if (action.operation === "generate_change_candidates") {
            state.candidates = result.payload as CandidateSet;
            const id = randomUUID();
            const api: ApiCandidates = {
              id,
              inputRevision: s.inputRevision,
              configVersion: s.configVersion,
              baselinePlanId: s.baselinePlan!.id,
              searchDescription: state.candidates.searchCoverage,
              candidates: state.candidates.candidates.map((c) => ({
                plan: candidatePackage(c.plan, s),
                metrics: [
                  {
                    name: "centerline_delta",
                    quantity: {
                      value: c.comparison.centerlineLengthDeltaM,
                      unit: "m",
                      reason: null,
                      basis: "proposed_inputs",
                    },
                  },
                ],
              })),
              rejected: state.candidates.rejected.map((r, i) => ({
                id: `rejected-${i}`,
                reason: r.reasons.map((x) => x.message).join("; "),
              })),
              gaps: state.candidates.reasons.map((r, i) => ({
                id: `generation-${i}`,
                subjectIds: [],
                reason: r.message,
              })),
            };
            context.publish({ candidates: api });
            state.refs.push({
              id,
              kind: "candidates",
              subjectId: s.changeRequest!.id,
              inputRevision: s.inputRevision,
              configVersion: s.configVersion,
            });
            if (!api.candidates.length) state.refs = [];
          } else if (
            action.operation === "derive_work_package" ||
            action.operation === "evaluate_work_package"
          ) {
            state.details = result.payload as Detail[];
            const results = state.details.map((d) =>
              summary(
                d,
                s.baselinePlan!.id === d.plan.id
                  ? s.baselinePlan!
                  : s.selectedPlan?.id === d.plan.id
                    ? s.selectedPlan
                    : candidatePackage(d.plan, s),
              ),
            );
            context.publish({ results });
            ref(
              action.operation === "derive_work_package"
                ? "package"
                : "evaluation",
            );
          } else if (action.operation === "export_work_package") {
            const files = result.payload as {
              bytes: Buffer;
              filename: string;
              contentType: string;
            }[];
            const selected = state.details.find(
              (d) => d.plan.id === (s.selectedPlan?.id ?? s.baselinePlan!.id),
            )!;
            context.publish({
              artifacts: files.map((file) => {
                const kind = file.filename.endsWith(".pdf")
                  ? ("pdf" as const)
                  : file.filename === "bom.csv"
                    ? ("bom_csv" as const)
                    : file.filename === "cut-list.csv"
                      ? ("cut_csv" as const)
                      : ("manifest" as const);
                const asset = context.registerArtifact(
                  file.bytes,
                  kind === "pdf"
                    ? "application/pdf"
                    : kind === "manifest"
                      ? "application/json"
                      : "text/csv",
                  file.filename,
                );
                return {
                  id: randomUUID(),
                  inputRevision: s.inputRevision,
                  configVersion: s.configVersion,
                  planId: selected.plan.id,
                  resultId: selected.id,
                  assetId: asset.id,
                  kind,
                };
              }),
            });
            ref("export");
          } else
            ref(
              action.operation === "prepare_drawing_model"
                ? "model"
                : "comparison",
            );
          return save();
        },
      };
      const records = new Map<string, RunRecord>();
      const workflow = new WorkflowRunner({
        domain,
        choice,
        configVersion,
        onEvent: options.onEvent,
        store: {
          interruptRunning() {},
          get: (id) => records.get(id),
          save(run) {
            records.set(run.id, structuredClone(run));
            if (!guard()) return;
            state.latestRun = structuredClone(run);
            context.progress(
              `${run.steps} operations: ${run.latestAction ?? "starting"}`,
            );
            if (run.question) {
              const s = current();
              context.publish({
                requests: [
                  ...s.outputs.requests.filter(
                    (r) =>
                      r.inputRevision === s.inputRevision &&
                      r.id !== requestId(run.question!.id),
                  ),
                  {
                    id: requestId(run.question.id),
                    inputRevision: s.inputRevision,
                    configVersion: s.configVersion,
                    question: run.question.text,
                    subjectIds: [],
                  },
                ],
              });
            }
            save();
          },
        },
      });
      const abort = () => workflow.cancel(initial.id);
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await workflow.start(
          initial.id,
          context.run.goal,
          initial,
          context.run.id,
        ).done;
        if (result.status === "failed") throw new Error(result.error);
        return {
          status:
            result.status === "completed"
              ? "completed"
              : result.status === "waiting_input"
                ? "waiting_input"
                : "blocked",
          stopReason: result.reason ?? result.status,
        };
      } finally {
        context.signal.removeEventListener("abort", abort);
      }
    },
  };
  packages = new WorkPackageService(store, configVersion, runner);
  return {
    packages,
    exports,
    detailStore,
    details(id: string) {
      const s = packages.get(id),
        state = detailStore.get(id);
      return {
        state: state ?? null,
        current:
          !!state &&
          state.inputRevision === s.inputRevision &&
          state.configVersion === s.configVersion,
        exportBinding: state
          ? (exportSnapshot(s, state)?.binding ?? null)
          : null,
      };
    },
  };
}
