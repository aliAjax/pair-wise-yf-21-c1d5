import { useStore } from "../store";
import type { OutboxItem } from "../types";
import { fmtTime } from "../utils";

const TYPE_LABEL: Record<OutboxItem["type"], string> = {
  fieldEdit: "字段补录",
  cardExpire: "色卡过期",
  cardRange: "范围调整",
  cardRecertify: "色卡复检启用",
  reassignCard: "重指派色卡",
  startProcedure: "工序开工",
  completeProcedure: "工序完工",
  resolveConflict: "冲突裁决",
};

function describe(item: OutboxItem, carpetNo: (id: string) => string): string {
  const p = item.payload as Record<string, unknown>;
  switch (item.type) {
    case "fieldEdit":
      return `${carpetNo(p.carpetId as string)} · ${String(p.field)}`;
    case "completeProcedure":
      return `完工 + 修复后记录`;
    case "resolveConflict":
      return "两版取其一";
    case "cardRange":
      return `范围 → ${String(p.newRange)}`;
    case "cardExpire":
      return `判过期：${String(p.reason)}`;
    case "cardRecertify":
      return `启用至 ${String(p.newValidUntil)}`;
    case "reassignCard":
      return "工序换卡";
    case "startProcedure":
      return "工序开工";
  }
}

const STATUS_LABEL: Record<OutboxItem["status"], string> = {
  pending: "待传",
  failed: "失败待补",
  rejected: "总档拒收",
  done: "已入库",
};

export default function SyncQueue() {
  const { outbox, online, syncing, syncNow, resendDone, clearDone, server } = useStore();
  const carpetNo = (id: string) =>
    server.carpets.find((c) => c.id === id)?.carpetNo ?? id;

  const unfinished = outbox.filter((i) => i.status === "pending" || i.status === "failed");
  const done = outbox.filter((i) => i.status === "done");
  const rejected = outbox.filter((i) => i.status === "rejected");

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>平板待传队列</p>
          <h2>断网补录 · 断点续传</h2>
        </div>
        <div className="queue-actions">
          <button className="primary" disabled={online === false || unfinished.length === 0 || syncing} onClick={syncNow}>
            {syncing ? "回补中…" : `立即回补（${unfinished.length}）`}
          </button>
          {done.length > 0 && <button className="ghost" onClick={clearDone}>清空已入库</button>}
        </div>
      </div>

      <ol className="outbox">
        {outbox.length === 0 && (
          <li className="muted empty-tip">队列为空。断网时所有改动都留在平板，回网后按顺序只补未完成项。</li>
        )}
        {unfinished.map((item) => (
          <li key={`${item.opId}-${item.attempts}`} className={`ob ob-${item.status}`}>
            <em className={`badge badge-${item.status === "failed" ? "danger" : "warn"}`}>
              {STATUS_LABEL[item.status]}
            </em>
            <span className="ob-type">{TYPE_LABEL[item.type]}</span>
            <span className="ob-desc">{describe(item, carpetNo)}</span>
            <small className="ob-time">{fmtTime(item.time)} · 第 {item.attempts + 1} 次尝试</small>
            {item.error && <small className="ob-err">{item.error}</small>}
          </li>
        ))}
        {rejected.map((item) => (
          <li key={item.opId} className="ob ob-rejected">
            <em className="badge badge-danger">总档拒收</em>
            <span className="ob-type">{TYPE_LABEL[item.type]}</span>
            <span className="ob-desc">{describe(item, carpetNo)}</span>
            <small className="ob-err">{item.error}</small>
          </li>
        ))}
        {done.map((item) => (
          <li key={item.opId} className="ob ob-done">
            <em className="badge badge-ok">已入库</em>
            <span className="ob-type">{TYPE_LABEL[item.type]}</span>
            <span className="ob-desc">{describe(item, carpetNo)}</span>
            <small className="ob-time">{fmtTime(item.lastAttemptAt ?? item.time)}</small>
            <button className="ghost tiny" onClick={() => resendDone(item.opId)}>
              重复提交（验证幂等）
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
