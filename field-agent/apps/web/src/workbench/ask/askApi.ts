import { ApiError, session } from "../api.js";

/** Mirrors apps/server/src/sources (ask.ts, types.ts). The server is the only source of these values. */
export type Origin = "project" | "sample" | "you" | "derived" | "catalog" | "document" | "photo";
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
  revision: { uploadId: string; revision: number; basis: "extracted" | "corrected"; label: string } | null;
  page: { image: string; number: number } | null;
  regions: Region[];
}
export interface Region { page: number; x: number; y: number; w: number; h: number }
export interface Claim { id: string; text: string; citations: string[]; kind: "note" | "pointer" | "quote"; status: "supported" | "unresolved"; reason?: string }
export interface AttachmentView {
  id: string; filename: string; kindLabel: string; preview: string; note: string;
  observations: Array<{ id: string; kind: "text" | "marking" | "dimension_text"; text: string; confidence: number; page: number; status: "read" | "unclear" | "confirmed" | "rejected" }>;
}
export interface ConditionCheck { question: string; name: string; value: number | null; unit: string; origin: Origin | null; detail: string | null; op: string; limit: number; result: "met" | "not_met" | "unknown" }
export interface ExceptionStatus { key: string; sectionId: string; parentSectionId: string; status: "applies" | "does_not_apply" | "unknown"; checks: ConditionCheck[]; note: string }
export interface AskAnswer {
  id: string; question: string; askedAt: string;
  context: {
    projectId: string | null; packageTitle: string | null; standard: string | null;
    edition: { value: string | null; status: "resolved" | "answered" | "unknown"; reason: string; script?: string };
    jurisdiction: string | null; selectedElementId: string | null;
    siteCondition: { id: string; description: string } | null;
    facts: ContextFact[];
  };
  status: "answered" | "needs_input" | "no_source";
  summary: string;
  explanation: Claim[]; unresolved: Claim[]; exceptions: ExceptionStatus[];
  missing: string[]; followUps: FollowUp[]; sources: Citation[];
  conflicts: Array<{ topic: string; resolution: string; items: Array<{ key: string; position: string; label: string }> }>;
  excluded: Array<{ docId: string; title: string; edition: string; reason: string }>;
  attachments: AttachmentView[];
  timings: { retrievalMs: number; compositionMs: number; modelMs: number; totalMs: number };
}
export interface AskRequest {
  question: string; packageId?: string; selectedElementId?: string;
  measurements?: Array<{ name: string; value: number; unit: string }>;
  answers?: { nfpa13Edition?: string; jurisdiction?: string; observations?: Record<string, "yes" | "no"> };
  attachments?: string[];
}
export interface SourceDocument {
  id: string; title: string; publisher: string; type: string; edition: string; demonstration: boolean;
  scope: Record<string, unknown>; url?: string; importedAt: string; sectionCount: number; flags: string[];
  authorization: { basis: string; display: string; maxQuoteChars?: number };
  upload?: { uploadId: string; revision: number; basis: "extracted" | "corrected"; pageCount: number };
}
export interface SectionView {
  key: string; docId: string; sectionId: string; heading: string; kind: string; parentKey: string | null;
  pageStart: number | null; pageEnd: number | null; text: string; table: string[][] | null; flags: string[];
  limited: string | null; notes?: Array<{ text: string; author: string }>; regions?: Region[];
}

export type UploadPurpose = "reference" | "site_photo";
export type UploadStatus = "uploaded" | "extracting" | "review" | "indexing" | "ready" | "failed";
export interface UploadRecord {
  id: string; purpose: UploadPurpose; filename: string; kind: string; kindLabel: string; mime: string; size: number;
  status: UploadStatus; failedStage?: "extracting" | "indexing"; error?: { code: string; message: string };
  projectId: string | null; pageCount: number | null; pages: Array<{ n: number; width: number; height: number; method: string; confidence: number | null }>;
  notes: string[]; review: { items: number; blocking: number }; revision: number; indexedRevision: number | null; docId: string | null;
  metadata: ReferenceMetadata | null;
  timings: { uploadMs?: number; decodeMs?: number; textMs?: number; ocrMs?: number; ocrPages?: number; extractMs?: number; indexMs?: number };
  createdAt: string; updatedAt: string;
}
export interface ReferenceMetadata {
  title: string; publisher: string; type: string; edition: string; scope: Record<string, unknown>; url?: string; demonstration: boolean;
  authorization: { basis: string; storeAndIndex: boolean; useWithAi: boolean; display: string; maxQuoteChars?: number };
}
export interface ReviewItem { id: string; kind: string; page: number; lineId: string | null; text: string; message: string; bbox: { x: number; y: number; w: number; h: number } | null; blocking: boolean }
export interface ReviewData {
  upload: UploadRecord;
  revision: { rev: number; basis: "extracted" | "corrected"; text: string; acknowledged: string[]; createdAt: string };
  revisions: Array<{ rev: number; basis: string; createdAt: string; author: string }>;
  items: ReviewItem[];
  pages: Array<{ n: number; width: number; height: number; method: string; confidence: number | null }>;
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

/** Uploads with progress. XMLHttpRequest is used because fetch has no upload progress. */
function sendUpload(file: File, fields: Record<string, string>, onProgress?: (fraction: number) => void): Promise<UploadRecord> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", file, file.name || "upload");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("Authorization", `Bearer ${session.token()}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body: { error?: string; code?: string } & Partial<UploadRecord> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* keep empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadRecord);
      else reject(new ApiError(xhr.status, body.code ?? String(xhr.status), body.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "The upload was interrupted. Check the connection and retry."));
    xhr.send(form);
  });
}

/** Fetches an authenticated file (page image, preview, original) as an object URL. */
export async function authedBlobUrl(href: string): Promise<string> {
  const res = await fetch(href, { headers: { Authorization: `Bearer ${session.token()}` } });
  if (!res.ok) throw new ApiError(res.status, String(res.status), "Could not load the file");
  return URL.createObjectURL(await res.blob());
}

export const askApi = {
  ask: (body: AskRequest) => call<AskAnswer>("/api/ask", { method: "POST", body: JSON.stringify(body) }),
  documents: () => call<{ documents: SourceDocument[] }>("/api/sources"),
  loadDemo: (projectId: string) => call<{ documents: SourceDocument[] }>("/api/sources/demo", { method: "POST", body: JSON.stringify({ projectId }) }),
  importDocument: (document: Record<string, unknown>) => call<SourceDocument>("/api/sources", { method: "POST", body: JSON.stringify({ document }) }),
  passage: (link: string) => call<{ document: SourceDocument; target: string; sections: SectionView[] }>(link),
  upload: sendUpload,
  uploads: (purpose?: UploadPurpose) => call<{ uploads: UploadRecord[] }>(`/api/uploads${purpose ? `?purpose=${purpose}` : ""}`),
  getUpload: (id: string) => call<UploadRecord>(`/api/uploads/${id}`),
  review: (id: string) => call<ReviewData>(`/api/uploads/${id}/review`),
  saveReview: (id: string, body: { text?: string; acknowledged?: string[]; metadata?: ReferenceMetadata }) => call<UploadRecord>(`/api/uploads/${id}/review`, { method: "PUT", body: JSON.stringify(body) }),
  indexUpload: (id: string, metadata: ReferenceMetadata) => call<UploadRecord>(`/api/uploads/${id}/index`, { method: "POST", body: JSON.stringify({ metadata }) }),
  retryUpload: (id: string) => call<UploadRecord>(`/api/uploads/${id}/retry`, { method: "POST" }),
  removeUpload: (id: string) => call<{ ok: true }>(`/api/uploads/${id}`, { method: "DELETE" }),
  async original(href: string): Promise<string> {
    const res = await fetch(href, { headers: { Authorization: `Bearer ${session.token()}` } });
    if (!res.ok) throw new ApiError(res.status, String(res.status), "Could not open the original file");
    return res.text();
  },
};
