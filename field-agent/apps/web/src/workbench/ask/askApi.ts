import { ApiError, session } from "../api.js";

/** Mirrors apps/server/src/sources (ask.ts, types.ts). The server is the only source of these values. */
export type Origin = "project" | "sample" | "you" | "derived" | "catalog" | "document";
export interface ContextFact { name: string; label: string; value: string | number | null; unit: string | null; origin: Origin; detail: string }
export interface FollowUp { id: string; question: string; kind: "choice" | "measurement"; field: string; options?: Array<{ value: string; label: string }>; unit?: string }
export interface Citation {
  key: string; docId: string; docTitle: string; publisher: string; type: string; typeLabel: string; edition: string;
  sectionId: string; heading: string; kind: string; label: string; role: string; via?: string;
  pageStart: number | null; pageEnd: number | null; demonstration: boolean;
  flags: Array<{ flag: string; label: string }>;
  quote: string | null; quoteNote: string | null; table: string[][] | null;
  notes: Array<{ text: string; author: string }>;
  link: string; original: string | null;
}
export interface Claim { id: string; text: string; citations: string[]; kind: "note" | "pointer"; status: "supported" | "unresolved"; reason?: string }
export interface ConditionCheck { question: string; name: string; value: number | null; unit: string; origin: Origin | null; detail: string | null; op: string; limit: number; result: "met" | "not_met" | "unknown" }
export interface ExceptionStatus { key: string; sectionId: string; parentSectionId: string; status: "applies" | "does_not_apply" | "unknown"; checks: ConditionCheck[]; note: string }
export interface Calculation {
  toolId: string; title: string; script: { module: string; fn: string; version: string };
  status: "ok" | "missing_inputs" | "out_of_scope" | "invalid_input";
  inputs: Array<{ name: string; label: string; value: number | string | null; unit: string | null; origin: Origin; detail: string }>;
  outputs: Array<{ name: string; label: string; value: number | string | null; unit: string | null }>;
  missing: string[]; message: string; limits: string; ms: number;
}
export interface AskAnswer {
  id: string; question: string; askedAt: string;
  classification: { kind: "source" | "calculation" | "both"; reason: string };
  context: {
    projectId: string | null; packageTitle: string | null; standard: string | null;
    edition: { value: string | null; status: "resolved" | "answered" | "unknown"; reason: string; script?: string };
    jurisdiction: string | null; selectedElementId: string | null;
    siteCondition: { id: string; description: string } | null;
    facts: ContextFact[];
  };
  status: "answered" | "needs_input" | "no_source" | "calculation_only";
  summary: string;
  explanation: Claim[]; unresolved: Claim[]; exceptions: ExceptionStatus[];
  missing: string[]; followUps: FollowUp[]; sources: Citation[];
  conflicts: Array<{ topic: string; resolution: string; items: Array<{ key: string; position: string; label: string }> }>;
  excluded: Array<{ docId: string; title: string; edition: string; reason: string }>;
  calculation: Calculation | null;
  timings: { retrievalMs: number; calculationMs: number; totalMs: number };
}
export interface AskRequest {
  question: string; packageId?: string; selectedElementId?: string;
  measurements?: Array<{ name: string; value: number; unit: string }>;
  answers?: { nfpa13Edition?: string; jurisdiction?: string };
}
export interface SourceDocument {
  id: string; title: string; publisher: string; type: string; edition: string; demonstration: boolean;
  scope: Record<string, unknown>; url?: string; importedAt: string; sectionCount: number; flags: string[];
  authorization: { basis: string; display: string; maxQuoteChars?: number };
}
export interface SectionView {
  key: string; docId: string; sectionId: string; heading: string; kind: string; parentKey: string | null;
  pageStart: number | null; pageEnd: number | null; text: string; table: string[][] | null; flags: string[];
  limited: string | null; notes?: Array<{ text: string; author: string }>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Authorization: `Bearer ${session.token()}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    let code = String(res.status), message = `Request failed (${res.status})`;
    try { const b = await res.json(); if (typeof b.code === "string") code = b.code; if (typeof b.error === "string") message = b.error; } catch { /* keep status */ }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export const askApi = {
  ask: (body: AskRequest) => call<AskAnswer>("/api/ask", { method: "POST", body: JSON.stringify(body) }),
  documents: () => call<{ documents: SourceDocument[] }>("/api/sources"),
  loadDemo: (projectId: string) => call<{ documents: SourceDocument[] }>("/api/sources/demo", { method: "POST", body: JSON.stringify({ projectId }) }),
  importDocument: (document: Record<string, unknown>) => call<SourceDocument>("/api/sources", { method: "POST", body: JSON.stringify({ document }) }),
  passage: (link: string) => call<{ document: SourceDocument; target: string; sections: SectionView[] }>(link),
  async original(href: string): Promise<string> {
    const res = await fetch(href, { headers: { Authorization: `Bearer ${session.token()}` } });
    if (!res.ok) throw new ApiError(res.status, String(res.status), "Could not open the original file");
    return res.text();
  },
};
