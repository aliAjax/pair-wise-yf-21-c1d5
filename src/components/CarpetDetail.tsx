import { useMemo, useState } from "react";
import { cardEffective } from "../engine";
import { useStore } from "../store";
import type { Carpet, FieldKey, Procedure } from "../types";

const MAIN_FIELDS: { key: FieldKey; label: string }[] = [
  { key: "origin", label: "地毯产地" },
  { key: "period", label: "年代" },
  { key: "knotDensity", label: "结密度" },
  { key: "material", label: "材质" },
  { key: "dyeType", label: "染色类型" },
  { key: "condition", label: "保存状态" },
];

function usePendingDrafts(carpetId: string) {
  const { outbox } = useStore();
  return useMemo(() => {
    const drafts = new Map<FieldKey, string>();
    for (const item of outbox) {
      if (
        item.type !== "fieldEdit" ||
        (item.status !== "pending" && item.status !== "failed")
      )
        continue;
      const p = item.payload as { carpetId: string; field: FieldKey; newValue: string };
      if (p.carpetId === carpetId) drafts.set(p.field, p.newValue);
    }
    return drafts;
  }, [outbox, carpetId]);
}

function FieldRow({
  carpet,
  fieldKey,
  label,
}: {
  carpet: Carpet;
  fieldKey: FieldKey;
  label: string;
}) {
  const { submitFieldEdit, simulateRemoteEdit, server, online } = useStore();
  const [value, setValue] = useState("");
  const drafts = usePendingDrafts(carpet.id);
  const draft = drafts.get(fieldKey);

  const conflict = server.revisions.find(
    (r) => r.carpetId === carpet.id && r.field === fieldKey && r.status === "conflict"
  );
  const current = fieldKey.startsWith("damage:")
    ? carpet.damages.find((d) => d.id === fieldKey.slice(7))?.note ?? ""
    : String(carpet[fieldKey as keyof Carpet]);

  const save = () => {
    if (!value.trim() || value === current) return;
    submitFieldEdit(carpet.id, fieldKey, value.trim());
    setValue("");
  };

  return (
    <div className={`field-row ${conflict ? "row-conflict" : ""}`}>
      <div className="field-row-head">
        <span className="field-label">{label}</span>
        {draft !== undefined && draft !== current && (
          <em className="badge badge-warn">平板草稿：{draft}</em>
        )}
        {conflict && <em className="badge badge-danger">两版待确认 ↓修订账</em>}
      </div>
      <div className="field-current">
        {current || <span className="muted">（未填写）</span>}
      </div>
      <div className="field-edit">
        <input
          value={value}
          placeholder={online ? `修改${label}（在线即时并回）` : `离线补录${label}…`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button onClick={save}>记</button>
        <button
          className="ghost"
          title="演示：离线期间其他终端也改了总档同一字段"
          onClick={() => {
            const v = window.prompt(`模拟总档他端修改「${label}」为：`, `${current}〔总档修订〕`);
            if (v && v.trim()) simulateRemoteEdit(carpet.id, fieldKey, v.trim());
          }}
        >
          模拟总档并发改
        </button>
      </div>
    </div>
  );
}

function ProcedureItem({ proc }: { proc: Procedure }) {
  const { server, submit } = useStore();
  const carpet = server.carpets.find((c) => c.id === proc.carpetId);
  const card = server.cards.find((c) => c.id === proc.cardId);
  const now = Date.now();
  const cardOk = card ? cardEffective(card, now) : false;
  const records = server.records.filter((r) => r.procedureId === proc.id);

  const statusText: Record<Procedure["status"], string> = {
    pending: "待开工",
    in_progress: "进行中",
    done: "已完工",
    voided: "已作废",
  };

  const finish = () => {
    const note = window.prompt("填写修复后记录（完工说明）：", "补线完成，纹样衔接自然，张力均衡");
    if (note === null) return;
    submit("completeProcedure", {
      procedureId: proc.id,
      afterNote: note || "修复后记录（未填写说明）",
    });
  };

  return (
    <article className={`proc proc-${proc.status}`}>
      <header>
        <h4>
          {proc.name}
          <em className={`badge badge-${proc.status}`}>{statusText[proc.status]}</em>
          {card && (
            <em className={cardOk ? "badge badge-ok" : "badge badge-danger"}>
              色卡：{card.colorName} {cardOk ? "有效" : "已失效"}
            </em>
          )}
        </h4>
      </header>

      {proc.voidReason && <p className="void-reason">作废原因：{proc.voidReason}</p>}

      {proc.status !== "voided" && proc.status !== "done" && (
        <div className="proc-actions">
          {proc.status === "pending" && (
            <button
              className="primary small"
              disabled={!cardOk}
              title={cardOk ? "" : "色卡失效，须先重算换卡"}
              onClick={() => submit("startProcedure", { procedureId: proc.id })}
            >
              开工
            </button>
          )}
          {proc.status === "in_progress" && (
            <button
              className="primary small"
              disabled={!cardOk}
              title={cardOk ? "" : "色卡复检已失效，工序作废重算中，禁止完工"}
              onClick={finish}
            >
              完工并记修复后
            </button>
          )}
          <label className="reassign">
            重指派色卡
            <select
              value={proc.cardId}
              onChange={(e) =>
                submit("reassignCard", { procedureId: proc.id, cardId: e.target.value })
              }
            >
              {server.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.colorName}（{c.range}）{cardEffective(c, now) ? "" : " · 已过期"}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {!cardOk && proc.status !== "voided" && proc.status !== "done" && (
        <p className="block-note">
          ⛔ 关联色卡已过期或范围调整，本工序已被要求重算，换有效色卡前不能开工/完工。
        </p>
      )}

      <div className="rec-list">
        {records.map((r) => (
          <div key={r.id} className={`rec rec-${r.phase} ${r.voidedAt ? "is-void" : ""}`}>
            <em>{r.phase === "before" ? "修复前" : "修复后"}</em>
            <span>{r.content}</span>
            {r.voidReason && <small>已作废：{r.voidReason}</small>}
          </div>
        ))}
      </div>

      {proc.successorId && (
        <p className="successor-link">↓ 已生成重算工序，见下方待开工列表（{carpet?.carpetNo}）</p>
      )}
    </article>
  );
}

export default function CarpetDetail() {
  const { server, selectedCarpetId } = useStore();
  const carpet = server.carpets.find((c) => c.id === selectedCarpetId) ?? server.carpets[0];
  const [activeDamage, setActiveDamage] = useState(carpet.damages[0]?.id ?? "");

  if (!carpet) return null;
  // 切换地毯后，若标记点不存在则回落到该地毯的第一个破损区域
  const damageId = carpet.damages.some((d) => d.id === activeDamage)
    ? activeDamage
    : (carpet.damages[0]?.id ?? "");
  const damageKey = `damage:${damageId}` as FieldKey;

  const procs = server.procedures.filter((p) => p.carpetId === carpet.id);

  return (
    <section className="panel detail-panel">
      <div className="heading">
        <div>
          <p>续作工作区</p>
          <h2>
            {carpet.carpetNo}
            <small className="title-sub">字段级修订 · 破损标记 · 工序与前后记录</small>
          </h2>
        </div>
      </div>

      {/* 纹样局部标记图 */}
      <div className="rug-map">
        <div className="rug-frame">
          <div className="rug-border" />
          <div className="rug-field">
            <div className="rug-medallion" />
            {carpet.damages.map((d) => (
              <button
                key={d.id}
                className={`damage-dot ${damageId === d.id ? "dot-on" : ""}`}
                style={{ left: `${d.x}%`, top: `${d.y}%` }}
                title={d.label}
                onClick={() => setActiveDamage(d.id)}
              >
                {d.id}
              </button>
            ))}
          </div>
        </div>
        <p className="rug-caption">纹样局部标记图：点击标记切换破损区域，补录内容按 damage 编号并回</p>
      </div>

      <div className="field-grid-rows">
        {MAIN_FIELDS.map((f) => (
          <FieldRow key={`${carpet.id}:${f.key}`} carpet={carpet} fieldKey={f.key} label={f.label} />
        ))}
      </div>

      <h3 className="subhead">破损区域补录</h3>
      <div className="damage-tabs">
        {carpet.damages.map((d) => (
          <button
            key={d.id}
            className={damageId === d.id ? "chip-on" : ""}
            onClick={() => setActiveDamage(d.id)}
          >
            {d.id} · {d.label}
          </button>
        ))}
      </div>
      <FieldRow key={`${carpet.id}:damage:${damageId}`} carpet={carpet} fieldKey={damageKey} label={`破损描述（${damageId}）`} />

      <h3 className="subhead">修复工序与前后记录</h3>
      <div className="proc-list">
        {procs.map((p) => (
          <ProcedureItem key={p.id} proc={p} />
        ))}
      </div>
    </section>
  );
}
