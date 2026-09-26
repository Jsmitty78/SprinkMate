import { useEffect, useState, type ReactNode } from "react";
import { readImage } from "./api.js";

export type Tone = "neutral" | "good" | "warning" | "bad" | "info";
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Spinner() { return <span className="spinner" aria-hidden="true" />; }
export function Button({ children, className = "", busy = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button {...props} className={`button ${className}`} aria-busy={busy || undefined}>{busy && <Spinner />}{children}</button>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">＋</span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
export function Section({ eyebrow, title, action, children, className = "" }: { eyebrow?: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><header className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{action}</header>{children}</section>;
}
export function AuthImage({ token, taskId, assetId, alt, className = "" }: { token: string; taskId: string; assetId: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null); setError(false);
    readImage(token, taskId, assetId, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, taskId, assetId, attempt]);
  if (error) return <span className="image-fallback">画像を読み込めませんでした<Button type="button" className="button-small" onClick={() => setAttempt(v => v + 1)}>再読込</Button></span>;
  if (!url) return <span className="image-fallback"><Spinner /><span>画像を読込中</span></span>;
  return <img className={className} src={url} alt={alt} />;
}

export const labels: Record<string, string> = {
  model: "製品型式", installation: "取付状態", mounting: "取付方式", orientation: "現物の方向", verticalReference: "上下の基準",
  installed: "取付済み", uninstalled: "未取付け", standard: "通常形・非埋込", recessed: "埋込",
  pendent: "下向き", upright: "上向き", sideways: "横向き", unknown: "不明",
  gravity: "重力方向", verified_record: "確認済みの記録", manual: "人が確認", model_source: "AIの候補", fixture: "合成データ",
  capture: "追加撮影", measurement: "追加計測", confirmation: "確認依頼",
  open: "回答待ち", answered: "回答済み", unavailable: "取得不能", superseded: "旧版・失効",
  active: "確認中", waiting: "追加情報待ち", review_ready: "資料作成済み", cancelled: "中止済み",
  idle: "待機中", queued: "実行待ち", running: "実行中", failed: "実行失敗",
};
export function label(value: string | null | undefined): string { return value ? labels[value] ?? value : "未入力"; }
export function fieldLabel(path: string): string {
  const [key, detail] = path.split(".");
  return `${label(key)}${detail?.startsWith("evidenceIds") ? "の根拠" : detail === "confirmation" ? "の確認" : detail ? ` · ${detail}` : ""}`;
}
export function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
