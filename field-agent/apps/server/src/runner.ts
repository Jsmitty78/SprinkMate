import { randomUUID } from 'node:crypto';
import type { FieldService } from './service.js';
import { AppError } from './models.js';

export interface AgentDriver {
  run(taskId: string, message: string, signal: AbortSignal): Promise<void>;
  dispose?(): void | Promise<void>;
}
interface Job {id:string;task_id:string;message:string;status:string}

/** Persist the work item before running it. One Pi turn per task; no turn waits for a person. */
export class TaskRunner {
  private running = new Map<string, {controller:AbortController;done:Promise<void>}>();
  private closing = false;
  constructor(readonly service:FieldService, private driver:AgentDriver, private timeoutMs=180_000) {}
  recover() {
    const rows=this.service.store.db.prepare("SELECT DISTINCT task_id FROM jobs WHERE status='pending'").all() as {task_id:string}[];
    for(const row of rows) this.kick(row.task_id);
  }
  enqueue(taskId:string,message='現行の観測と図面を確認し、不足情報を要求して検証を進めてください。',id:string=randomUUID()) {
    if(typeof message!=='string'||!message.trim()||message.length>8000) throw new AppError(400,'指示は1〜8000文字で入力してください');
    const task=this.service.getTask(taskId);
    if(task.state==='cancelled') throw new AppError(409,'この仕事はキャンセル済みです');
    const existing=this.service.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job|undefined;
    if(existing) {
      if(existing.task_id!==taskId||existing.message!==message) throw new AppError(409,'同じ実行IDが別の内容で使われています');
      return existing;
    }
    const count=(this.service.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE task_id=? AND status IN ('pending','running')").get(taskId) as {n:number}).n;
    if(count>=8) throw new AppError(429,'実行待ちが多いため、処理の完了を待ってください');
    this.service.store.db.transaction(()=>{
      this.service.store.db.prepare("INSERT INTO jobs(id,task_id,message,status,created_at) VALUES(?,?,?,'pending',?)").run(id,taskId,message,new Date().toISOString());
      task.run={status:this.running.has(taskId)?'running':'queued'}; this.service.store.save(task);
      this.service.store.event(taskId,'run_queued',{id});
    })();
    this.kick(taskId);return {id,task_id:taskId,message,status:'pending'};
  }
  private kick(taskId:string) {
    if(this.closing||this.running.has(taskId)) return;
    const controller=new AbortController();
    // Defer until the map is populated, including when the driver fails synchronously.
    const done=Promise.resolve().then(()=>this.drain(taskId,controller)).finally(()=>{
      this.running.delete(taskId);
      // An enqueue can land after drain observed an empty queue but before this cleanup.
      if(!this.closing&&this.service.getTask(taskId).state!=='cancelled'&&this.service.store.db.prepare("SELECT 1 FROM jobs WHERE task_id=? AND status='pending' LIMIT 1").get(taskId))this.kick(taskId);
    });
    this.running.set(taskId,{controller,done});
  }
  private async drain(taskId:string,controller:AbortController) {
    while(!this.closing&&!controller.signal.aborted) {
      const job=this.service.store.db.prepare("SELECT * FROM jobs WHERE task_id=? AND status='pending' ORDER BY rowid LIMIT 1").get(taskId) as Job|undefined;
      if(!job) break;
      const before=this.service.getTask(taskId); if(before.state==='cancelled') break;
      this.service.store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
      before.run={status:'running'};this.service.store.save(before);this.service.store.event(taskId,'run_started',{id:job.id});
      const turnController=new AbortController();
      const onAbort=()=>turnController.abort();controller.signal.addEventListener('abort',onAbort,{once:true});
      const timeout=setTimeout(()=>turnController.abort(),this.timeoutMs);
      try {
        await this.driver.run(taskId,job.message,turnController.signal);
        if(turnController.signal.aborted) throw new Error('aborted');
        this.service.store.db.prepare("UPDATE jobs SET status='completed' WHERE id=? AND status='running'").run(job.id);
        const task=this.service.getTask(taskId);
        if(task.state!=='cancelled') {task.run={status:'idle'};this.service.store.save(task);this.service.store.event(taskId,'run_completed',{id:job.id});}
      } catch {
        const task=this.service.getTask(taskId);
        if(this.closing) {
          this.service.store.db.prepare("UPDATE jobs SET status='pending' WHERE id=? AND status='running'").run(job.id);
          if(task.state!=='cancelled') {task.run={status:'queued'};this.service.store.save(task);}
        } else if(task.state!=='cancelled') {
          const message=turnController.signal.aborted?'Piの実行時間上限に達しました。記録を保ったまま再開できます。':'Piを実行できませんでした。モデル設定・認証・接続を確認して再開してください。';
          this.service.store.db.prepare("UPDATE jobs SET status='failed',error=? WHERE id=?").run(message,job.id);
          task.run={status:'failed',error:message};this.service.store.save(task);this.service.store.event(taskId,'run_failed',{id:job.id,message});
        }
      } finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',onAbort);}
    }
  }
  cancel(taskId:string) {this.service.cancel(taskId);this.running.get(taskId)?.controller.abort();return this.service.getTask(taskId);}
  async idle(taskId:string) {while(this.running.has(taskId))await this.running.get(taskId)?.done;}
  async close() {
    this.closing=true;
    for(const job of this.running.values()) job.controller.abort();
    await Promise.all([...this.running.values()].map(r=>r.done));await this.driver.dispose?.();
  }
}
