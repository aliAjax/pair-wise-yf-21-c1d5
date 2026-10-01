import { useStore } from "../store";
import type { FieldRevision } from "../types";
import { fmtTime } from "../utils";

function RevisionRow({ rev }: { rev: FieldRevision }) {
  const { submit } = useStore();

  return (
    <article className={`rev rev-${rev.status}`}>
      <header>
        <h4>
          {rev.carpetNo} · {rev.fieldLabel}
          <em
            className={
              rev.status === "conflict"
                ? "badge badge-danger"
                : rev.status === "resolved"
                  ? "badge badge-ok"
                  : "badge badge-gray"
            }
          >
            {rev.status === "conflict"
              ? "两版待确认"
              : rev.status === "resolved"
                ? `已取${rev.winner === "client" ? "平板版" : "总档版"}`
                : "已并回"}
          </em>
        </h4>
        <small>{fmtTime(rev.updatedAt)} · opId …{rev.opId.slice(-6)}</small>
      </header>

      <div className="rev-versions">
        <div className="rev-col rev-base">
          <span>断网前原值（base）</span>
          <p>{rev.baseValue || "（空）"}</p>
        </div>
        <div className="rev-col rev-client">
          <span>平板离线版</span>
          <p>{rev.clientValue}</p>
        </div>
        {rev.serverValue !== undefined && (
          <div className="rev-col rev-server">
            <span>总档版</span>
            <p>{rev.serverValue}</p>
          </div>
        )}
      </div>

      <p className="rev-reason">{rev.reason}</p>

      {rev.status === "conflict" && (
        <div className="rev-actions">
          <span>字段保持总档现值，不会被后写覆盖。请确认保留哪一版：</span>
          <button
            className="primary small"
            onClick={() =>
              submit("resolveConflict", { revisionId: rev.id, winner: "client" })
            }
          >
            采用平板版
          </button>
          <button
            className="small"
            onClick={() =>
              submit("resolveConflict", { revisionId: rev.id, winner: "server" })
            }
          >
            采用总档版
          </button>
        </div>
      )}
    </article>
  );
}

export default function RevisionLedger() {
  const { server } = useStore();
  const conflicts = server.revisions.filter((r) => r.status === "conflict");
  const others = server.revisions.filter((r) => r.status !== "conflict");

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>续作修订账</p>
          <h2>字段级并回记录</h2>
        </div>
        <small className="muted">按「地毯编号 + 字段」并回；同字段两边都改 → 留两版，不覆盖</small>
      </div>

      {server.revisions.length === 0 && (
        <p className="muted empty-tip">
          还没有并回记录。可在断网状态下修改地毯字段，再用「模拟总档并发改」制造同一字段两边都改的场景。
        </p>
      )}

      {conflicts.length > 0 && (
        <>
          <h3 className="subhead danger-text">待确认（{conflicts.length}）</h3>
          <div className="rev-list">
            {conflicts.map((r) => (
              <RevisionRow key={r.id} rev={r} />
            ))}
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <h3 className="subhead">已并回 / 已裁决（{others.length}）</h3>
          <div className="rev-list">
            {others.map((r) => (
              <RevisionRow key={r.id} rev={r} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
