import { useState } from "react";
import { useStore } from "../store";

const ORIGINS = ["全部", "波斯", "安纳托利亚", "藏毯"];

export default function CarpetList() {
  const { server, selectedCarpetId, setSelectedCarpetId, outbox } = useStore();
  const [origin, setOrigin] = useState("全部");

  const conflictCarpetIds = new Set(
    server.revisions.filter((r) => r.status === "conflict").map((r) => r.carpetId)
  );
  const pendingCarpetIds = new Set(
    outbox
      .filter((i) => i.type === "fieldEdit" && (i.status === "pending" || i.status === "failed"))
      .map(
        (i) =>
          (i.payload as { carpetId: string }).carpetId
      )
  );

  const carpets = server.carpets.filter(
    (c) => origin === "全部" || c.origin === origin
  );

  const activeProcs = server.procedures.filter((p) => p.status !== "voided");
  const doneCount = activeProcs.filter((p) => p.status === "done").length;

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>档案列表</p>
          <h2>地毯总档</h2>
        </div>
      </div>

      <div className="chips">
        {ORIGINS.map((o) => (
          <button
            key={o}
            className={origin === o ? "chip-on" : ""}
            onClick={() => setOrigin(o)}
          >
            {o}
          </button>
        ))}
      </div>

      <div className="carpet-list">
        {carpets.map((c) => {
          const procs = server.procedures.filter(
            (p) => p.carpetId === c.id && p.status !== "voided"
          );
          const done = procs.filter((p) => p.status === "done").length;
          return (
            <article
              key={c.id}
              className={`carpet-row ${c.id === selectedCarpetId ? "selected" : ""}`}
              onClick={() => setSelectedCarpetId(c.id)}
            >
              <div>
                <h3>
                  {c.carpetNo}
                  {conflictCarpetIds.has(c.id) && (
                    <em className="badge badge-danger">两版待确认</em>
                  )}
                  {pendingCarpetIds.has(c.id) && (
                    <em className="badge badge-warn">离线待并回</em>
                  )}
                </h3>
                <p>
                  {c.origin} · {c.period} · {c.knotDensity} · {c.dyeType}
                </p>
              </div>
              <div className="carpet-meta">
                <span>{c.damages.length} 处破损</span>
                <span>
                  工序 {done}/{procs.length}
                </span>
              </div>
            </article>
          );
        })}
      </div>

      <div className="mini-metrics">
        <div>
          <strong>{server.carpets.length}</strong>
          <small>纹样档案</small>
        </div>
        <div>
          <strong>{server.cards.length}</strong>
          <small>色卡数量</small>
        </div>
        <div>
          <strong>{server.revisions.filter((r) => r.status === "conflict").length}</strong>
          <small>待确认两版</small>
        </div>
        <div>
          <strong>{activeProcs.length ? Math.round((doneCount / activeProcs.length) * 100) : 0}%</strong>
          <small>完工率</small>
        </div>
      </div>
    </section>
  );
}
