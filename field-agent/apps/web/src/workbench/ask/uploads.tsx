import { tr } from "../locale.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Icon } from "../ui.js";
import { askApi, authedBlobUrl, type UploadRecord, type UploadStatus } from "./askApi.js";

/**
 * Shared upload pieces for Ask Sprink: file choosing (picker, camera, drag and drop, paste),
 * status polling, and authenticated image loading. Files are never exposed on public URLs, so
 * every image is fetched with the app token and shown through an object URL.
 */

/** What the picker offers. The server still checks the bytes; this list only helps the file dialog. */
export const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.tif,.tiff,.bmp,.gif,.avif,application/pdf,image/*";
/** Browsers that can show these directly get an instant local preview; others wait for the server's. */
const BROWSER_PREVIEW = /^image\/(jpeg|png|webp|gif|bmp|avif)$/;
export const MAX_MB = 40;

export const STATUS_LABEL: Record<UploadStatus, string> = {
  uploaded: "Uploaded", extracting: "Reading text", review: "Needs review", indexing: "Indexing", ready: "Ready", failed: "Failed",
};
const STATUS_TONE: Record<UploadStatus, "neutral" | "amber" | "blue" | "red"> = {
  uploaded: "neutral", extracting: "blue", review: "amber", indexing: "blue", ready: "neutral", failed: "red",
};
export const StatusBadge = ({ u }: { u: Pick<UploadRecord, "status" | "purpose"> }) =>
  <Badge tone={STATUS_TONE[u.status]}>{u.status === "ready" && u.purpose === "site_photo" ? tr("Ready as context") : u.status === "ready" ? tr("Searchable") : tr(STATUS_LABEL[u.status])}</Badge>;

export const isBusy = (s: UploadStatus) => s === "uploaded" || s === "extracting" || s === "indexing";
export const localPreview = (file: File) => BROWSER_PREVIEW.test(file.type) ? URL.createObjectURL(file) : null;

/** Loads an authenticated image; revokes the object URL when it changes or unmounts. */
export function useAuthedUrl(href: string | null | undefined): { url: string | null; error: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });
  useEffect(() => {
    if (!href) { setState({ url: null, error: false }); return; }
    let live = true, made: string | null = null;
    authedBlobUrl(href).then(u => { made = u; if (live) setState({ url: u, error: false }); else URL.revokeObjectURL(u); }).catch(() => live && setState({ url: null, error: true }));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [href]);
  return state;
}

/** Polls an upload while the server is working on it. */
export function useUploadPoll(record: UploadRecord | null, onChange: (u: UploadRecord) => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!record || !isBusy(record.status)) return;
    let live = true, delay = 600;
    const tick = async () => {
      if (!live) return;
      try { const u = await askApi.getUpload(record.id); if (!live) return; if (u.status !== record.status || u.updatedAt !== record.updatedAt) cb.current(u); if (isBusy(u.status)) { delay = Math.min(delay * 1.4, 3000); setTimeout(tick, delay); } }
      catch { if (live) setTimeout(tick, 3000); }
    };
    const t = setTimeout(tick, delay);
    return () => { live = false; clearTimeout(t); };
  }, [record?.id, record?.status]);
}

/** File buttons: choose files, and on phones take a photo with the camera. */
export function FileButtons({ onFiles, label = "Attach", camera = true, disabled }: { onFiles: (files: File[]) => void; label?: string; camera?: boolean; disabled?: boolean }) {
  const pick = useRef<HTMLInputElement>(null), cam = useRef<HTMLInputElement>(null);
  const take = (list: FileList | null, el: HTMLInputElement | null) => { if (list?.length) onFiles([...list]); if (el) el.value = ""; };
  return <>
    <input ref={pick} type="file" multiple accept={ACCEPT} hidden onChange={e => take(e.target.files, e.target)} data-testid="file-input" />
    <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={e => take(e.target.files, e.target)} />
    <Button variant="quiet" disabled={disabled} onClick={() => pick.current?.click()}><Icon name="attach" size={16} />{tr(label)}</Button>
    {camera && <Button variant="quiet" className="fa-only-touch" disabled={disabled} onClick={() => cam.current?.click()}><Icon name="camera" size={16} />{tr("Photo")}</Button>}
  </>;
}

/** Accepts dropped files anywhere inside it, and pasted images while it has focus within. */
export function DropArea({ onFiles, children, className = "", hint }: { onFiles: (files: File[]) => void; children: ReactNode; className?: string; hint: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return <div className={`fa-droparea ${over ? "is-over" : ""} ${className}`}
    onDragEnter={e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); depth.current += 1; setOver(true); } }}
    onDragOver={e => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); }}
    onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
    onDrop={e => { e.preventDefault(); depth.current = 0; setOver(false); const f = [...e.dataTransfer.files]; if (f.length) onFiles(f); }}
    onPaste={e => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); onFiles(f.map((x, i) => x.name && x.name !== "image.png" ? x : new File([x], `pasted-${Date.now()}-${i + 1}.${(x.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`, { type: x.type }))); } }}>
    {children}
    {over && <div className="fa-droparea-hint"><Icon name="attach" size={20} />{hint}</div>}
  </div>;
}

export const sizeText = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
