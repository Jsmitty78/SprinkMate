import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, read, taskPath, write } from "./api.js";
import { TaskDetail } from "./TaskDetail.js";
import type { Action, TaskSnapshot, TaskSummary } from "./types.js";
import { Badge, Button, dateTime, label, Spinner } from "./ui.js";

const tokenKey = "field-agent.token";

function Connection({ initial = "", onConnect }: { initial?: string; onConnect: (token: string) => void }) {
  const [value, setValue] = useState(initial);
  return <div className="connection-page"><div className="connection-story"><a className="brand" href="/" aria-label="Fieldnote ホーム"><span className="brand-icon">f<span>.</span></span><span>Fieldnote<small>現場の確認を、一件ずつ。</small></span></a><div><p className="eyebrow">OBSERVE. VERIFY. HAND OFF.</p><h1>その写真から、<br />次の判断へ。</h1><p>現場の観測を図面と結びつけ、<br />足りない情報と、確認できたことを残す。</p></div><div className="connection-flow"><span>01 撮る</span><span>02 確かめる</span><span>03 引き継ぐ</span></div></div><div className="connection-form-wrap"><form className="connection-form" onSubmit={event => { event.preventDefault(); if (value.trim()) onConnect(value.trim()); }}><p className="eyebrow">CONNECT TO YOUR WORKSPACE</p><h2>作業スペースに接続</h2><p>サーバーのアクセストークンを入力してください。</p><label className="form-field"><span>アクセストークン</span><input type="password" autoComplete="off" autoFocus value={value} onChange={event => setValue(event.target.value)} placeholder="サーバーに設定したトークン" required /></label><Button className="button-primary" type="submit" disabled={!value.trim()}>接続する <span aria-hidden="true">→</span></Button><p className="muted">トークンは、このタブのセッションに保存されます。</p></form><p className="connection-scope">初版の確認範囲：図面との差異、追加観測、採用したメーカー条件。設備全体の適合判定ではありません。</p></div></div>;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) ?? "");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [authError, setAuthError] = useState(false);
  const [notice, setNotice] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [planOrientation, setPlanOrientation] = useState("pendent");
  const selected = useRef<string | null>(null);
  const currentToken = useRef(token);
  const requestSerial = useRef(0);
  const performing = useRef(false);
  const currentBusy = useRef(false);

  function selectTask(id: string) {
    selected.current = id; setSelectedId(id); setTask(null); setError("");
  }
  const refresh = useCallback(async () => {
    if (!token) return;
    const serial = ++requestSerial.current;
    const items = await read<TaskSummary[]>(token, "/tasks");
    if (currentToken.current !== token || serial !== requestSerial.current) return;
    setTasks(items); setAuthError(false);
    const target = selected.current ?? items[0]?.id;
    if (!target) { setTask(null); return; }
    if (!selected.current) { selected.current = target; setSelectedId(target); }
    const snapshot = await read<TaskSnapshot>(token, taskPath(target));
    if (currentToken.current !== token || serial !== requestSerial.current || selected.current !== target) return;
    setTask(snapshot);
  }, [token]);

  const showError = useCallback((failure: unknown) => {
    setError(failure instanceof Error ? failure.message : "操作に失敗しました。もう一度お試しください。");
    setAuthError(failure instanceof ApiError && failure.status === 401);
  }, []);

  useEffect(() => {
    if (!token) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const poll = async () => {
      try { if (!currentBusy.current) await refresh(); }
      catch (failure) { if (!closed) showError(failure); }
      finally {
        if (!closed) { setLoading(false); timer = setTimeout(() => void poll(), 3500); }
      }
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); requestSerial.current++; };
  }, [token, selectedId, refresh, showError]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const action: Action = async (name, work, after) => {
    if (performing.current) return false;
    performing.current = true; currentBusy.current = true; setBusy(name); setError(""); setNotice("");
    requestSerial.current++;
    try {
      await work();
      await refresh();
      after?.();
      setNotice(`${name}：完了しました。`);
      return true;
    } catch (failure) { showError(failure); return false; }
    finally { performing.current = false; currentBusy.current = false; setBusy(""); }
  };

  function connect(next: string) {
    currentToken.current = next; selected.current = null; requestSerial.current++;
    setSelectedId(null); setTask(null); setTasks([]); setError(""); setAuthError(false);
    sessionStorage.setItem(tokenKey, next); setToken(next);
  }
  function disconnect() {
    currentToken.current = ""; requestSerial.current++; selected.current = null;
    sessionStorage.removeItem(tokenKey); setToken(""); setSelectedId(null); setTask(null); setTasks([]); setError("");
  }
  async function createTask() {
    await action("仕事を作成", async () => {
      const created = await write<TaskSnapshot>(token, "/tasks", { ...(newTitle.trim() ? { title: newTitle.trim() } : {}), planOrientation });
      selected.current = created.id; setSelectedId(created.id); setTask(created);
    }, () => { setNewTitle(""); setCreateOpen(false); });
  }

  if (!token) return <Connection onConnect={connect} />;
  return <div className="app-shell"><aside className="sidebar"><a href="/" className="brand"><span className="brand-icon">f<span>.</span></span><span>Fieldnote<small>現場確認ワークスペース</small></span></a><div className="sidebar-label"><span>仕事</span><span>{tasks.length}</span></div><Button className="new-task-button" onClick={() => setCreateOpen(value => !value)} disabled={!!busy}><span aria-hidden="true">＋</span> 新しい仕事</Button>{createOpen && <form className="create-form" onSubmit={event => { event.preventDefault(); void createTask(); }}><label className="form-field"><span>仕事の名前</span><input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="配管1区間の現場確認" autoFocus /></label><label className="form-field"><span>図面の指定方向</span><select value={planOrientation} onChange={event => setPlanOrientation(event.target.value)}>{["pendent", "upright", "sideways"].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label><Button type="submit" className="button-primary" busy={busy === "仕事を作成"} disabled={!!busy}>作成</Button></form>}<nav className="task-list" aria-label="仕事一覧">{tasks.map(item => <button key={item.id} className={`task-list-item ${item.id === selectedId ? "selected" : ""}`} onClick={() => selectTask(item.id)} disabled={!!busy}><span className={`task-list-dot state-${item.state}`} /><span><strong>{item.title}</strong><small>{label(item.state)} · {dateTime(item.updatedAt)}</small></span>{(item.run.status === "running" || item.run.status === "queued") && <Spinner />}</button>)}</nav><div className="sidebar-footer"><div><span className={`connection-dot ${authError ? "disconnected" : ""}`} /><span>{authError ? "認証の確認が必要" : "作業スペース接続中"}</span></div><button onClick={disconnect} disabled={!!busy}>トークンを変更 / 接続を解除 ↗</button><p>iPhoneの撮影と、Webの確認を<br />同じ仕事へつなぎます。</p></div></aside><main className="workspace"><div className="workspace-topbar"><span>現場の確認・変更検討</span><div>{busy && <span className="working-indicator" role="status"><Spinner />{busy}</span>}<button className="refresh-button" onClick={() => { setError(""); void refresh().catch(showError); }} disabled={!!busy} aria-label="最新の状態を読み込む">↻ <span>更新</span></button></div></div>{error && <div className="global-error" role="alert"><div><strong>操作を確認してください</strong><p>{error}</p></div>{authError ? <Button className="button-small" onClick={disconnect}>トークンを入力し直す</Button> : <button className="dismiss" aria-label="エラーを閉じる" onClick={() => setError("")}>×</button>}</div>}{notice && <div className="toast" role="status">✓ {notice}</div>}<div className="workspace-content">{task ? <TaskDetail key={task.id} task={task} token={token} action={action} busy={busy} /> : loading || (selectedId && !error) ? <div className="loading-workspace"><Spinner /><p>仕事を読み込んでいます</p></div> : <div className="welcome"><div className="welcome-symbol" aria-hidden="true">⌗</div><p className="eyebrow">YOUR NEXT FIELD TASK</p><h1>現場の確認を、<br />ここから始めましょう。</h1><p>写真、図面、追加の計測を一件にまとめ、<br />確認したことと残る問題を資料にします。</p><Button className="button-primary" onClick={() => setCreateOpen(true)} disabled={!!busy || authError}>＋ 新しい仕事を作る</Button><div className="welcome-steps"><div><b>01</b><strong>対象を決める</strong><p>図面の1区間と、確認する対象。</p></div><div><b>02</b><strong>根拠をそろえる</strong><p>写真や実測で、不明な点を解消。</p></div><div><b>03</b><strong>資料に残す</strong><p>限定ルールの結果と、未解決事項。</p></div></div></div>}</div></main></div>;
}
