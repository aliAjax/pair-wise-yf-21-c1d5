import { useMemo, useState } from "react";
import { StoreProvider, useStore } from "./store";
import type {
  BeforeAfterRecord,
  ColorCard,
  DamageArea,
  Kind,
  ProcessStatus,
  RepairProcess,
} from "./types";

/* ---------- 展示工具 ---------- */

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("、") : "（空）";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const KIND_LABEL: Record<Kind, string> = {
  carpet: "地毯档案",
  damage: "破损区域",
  card: "材料色卡",
  process: "修复工序",
  record: "修复前后记录",
};

const STATUS_BADGE: Record<string, string> = {
  有效: "badge badge-ok",
  已完工: "badge badge-ok",
  已重算: "badge badge-ok",
  已采用本地: "badge badge-ok",
  已采用服务端: "badge badge-ok",
  进行中: "badge badge-doing",
  待处理: "badge badge-doing",
  范围已调整: "badge badge-warn",
  待重算: "badge badge-warn",
  待确认: "badge badge-warn",
  过期: "badge badge-void",
  作废: "badge badge-void",
};

function Badge({ value }: { value: string }) {
  return <span className={STATUS_BADGE[value] ?? "badge"}>{value}</span>;
}

/* ---------- 同步条 ---------- */

function SyncBar() {
  const s = useStore();
  return (
    <section className="panel syncbar">
      <div className="sync-row">
        <div className="sync-net">
          <span className={s.online ? "dot dot-on" : "dot dot-off"} />
          <strong>{s.online ? "在线（总档可同步）" : "断网（平板离线记录中）"}</strong>
        </div>
        <div className="sync-actions">
          <button onClick={s.toggleOnline}>
            {s.online ? "模拟断网" : "恢复网络"}
          </button>
          <button
            className={s.weakNetwork ? "primary" : ""}
            onClick={s.toggleWeak}
            title="弱网下上传会随机中断，用于验证断点续传"
          >
            弱网模式：{s.weakNetwork ? "开" : "关"}
          </button>
          <button
            className="primary"
            disabled={s.syncing || !s.online || s.outbox.length === 0}
            onClick={s.syncNow}
          >
            {s.syncing
              ? "上传中…"
              : s.outbox.length
                ? `上传 / 补传 ${s.outbox.length} 条`
                : "离线内容已全部回网"}
          </button>
          <button
            disabled={s.syncing}
            onClick={s.demoDuplicateSubmit}
            title="把上一批操作用同一 opId 再提交一次，服务端幂等去重"
          >
            重复提交演示
          </button>
        </div>
      </div>
      <div className="sync-meta">
        <span>
          待上传 <b>{s.outbox.length}</b> 条
        </span>
        <span>
          服务端修订 <b>r{s.server.rev}</b>
        </span>
        <span>
          冲突待确认 <b className="text-warn">{s.server.conflicts.filter((c) => c.status === "待确认").length}</b> 条
        </span>
        {s.lastUploaded > 0 && <span>本批已确认 {s.lastUploaded} 条</span>}
      </div>
      {s.error && <p className="sync-error">{s.error}</p>}
    </section>
  );
}

/* ---------- 指标 ---------- */

function Metrics() {
  const s = useStore();
  const processes = Object.values(s.draft.processes);
  const pending = processes.filter((p) => p.status === "待处理" || p.status === "进行中").length;
  const done = processes.filter((p) => p.status === "已完工").length;
  const rate = processes.length ? Math.round((done / processes.length) * 100) : 0;
  const items = [
    ["待修复", pending],
    ["纹样档案", Object.keys(s.draft.carpets).length],
    ["色卡数量", Object.keys(s.draft.cards).length],
    ["完工率", `${rate}%`],
  ];
  return (
    <section className="metrics">
      {items.map(([label, value]) => (
        <article key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

/* ---------- 纹样局部标记图 ---------- */

const PIN_POS: Record<string, { x: number; y: number }> = {
  边缘: { x: 16, y: 24 },
  中心: { x: 50, y: 50 },
  毯面: { x: 72, y: 30 },
  边角: { x: 84, y: 80 },
};

function pinPos(d: DamageArea, index: number): { x: number; y: number } {
  const hit = Object.entries(PIN_POS).find(([k]) => d.position.includes(k));
  if (hit) return hit[1];
  const n =
    d.position.split("").reduce((a, c) => a + c.charCodeAt(0), 0) + index * 17;
  return { x: 20 + (n % 60), y: 20 + ((n * 7) % 60) };
}

function PatternMap({
  carpetNo,
  damages,
}: {
  carpetNo: string;
  damages: DamageArea[];
}) {
  const s = useStore();
  const marked = damages.filter((d) => d.marked);
  const addMarker = (e: React.MouseEvent<SVGSVGElement>) => {
    const seq = damages.length + 1;
    const id = `dmg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const d: DamageArea = {
      id,
      carpetNo,
      position: `标记点-${seq}`,
      type: "待查",
      size: "",
      marked: true,
    };
    s.commit({ kind: "damage", key: id, carpetNo, field: "*", value: d });
  };
  return (
    <svg
      className="pattern-map"
      viewBox="0 0 100 100"
      onClick={addMarker}
      role="img"
      aria-label="纹样局部标记图，点击添加破损标记"
    >
      <rect x="2" y="2" width="96" height="96" rx="6" fill="#fbf3e4" stroke="#b45309" strokeWidth="1.5" />
      <rect x="10" y="10" width="80" height="80" rx="4" fill="none" stroke="#d6a06a" strokeWidth="0.8" strokeDasharray="3 2" />
      <text x="50" y="54" textAnchor="middle" fontSize="7" fill="#b08968">
        {carpetNo} 纹样局部
      </text>
      {marked.map((d, i) => {
        const p = pinPos(d, i);
        return (
          <g key={d.id}>
            <circle cx={p.x} cy={p.y} r="4.5" fill="#dc2626" stroke="#fff" strokeWidth="1.2" />
            <text x={p.x} y={p.y + 2.2} textAnchor="middle" fontSize="4" fill="#fff">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- 档案详情 ---------- */

function FieldInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label>
      <span>{label}</span>
      <input
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function CarpetDetail({ carpetNo }: { carpetNo: string }) {
  const s = useStore();
  const carpet = s.draft.carpets[carpetNo];
  const damages = Object.values(s.draft.damages).filter((d) => d.carpetNo === carpetNo);
  const processes = Object.values(s.draft.processes).filter((p) => p.carpetNo === carpetNo);
  const records = Object.values(s.draft.records).filter((r) => r.carpetNo === carpetNo);
  const cards = Object.values(s.draft.cards);
  if (!carpet) return <p className="empty">请选择一条地毯档案。</p>;

  const commitField = (field: string, value: unknown) =>
    s.commit({ kind: "carpet", key: carpetNo, field, value });

  const addDamage = () => {
    const id = `dmg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    s.commit({
      kind: "damage",
      key: id,
      carpetNo,
      field: "*",
      value: { id, carpetNo, position: "新标记点", type: "待查", size: "", marked: true } as DamageArea,
    });
  };

  const addProcess = () => {
    const id = `prc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    s.commit({
      kind: "process",
      key: id,
      carpetNo,
      field: "*",
      value: { id, carpetNo, name: "新工序", cardId: undefined, checked: false, status: "待处理" } as RepairProcess,
    });
  };

  const addRecord = (processId: string, kind: "修复前" | "修复后") => {
    const id = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    s.commit({
      kind: "record",
      key: id,
      carpetNo,
      field: "*",
      value: { id, processId, carpetNo, kind, note: "", status: "有效" } as BeforeAfterRecord,
    });
  };

  return (
    <div className="detail">
      <div className="heading">
        <div>
          <p>地毯编号</p>
          <h2>{carpet.no}</h2>
        </div>
        <Badge value={processes.some((p) => p.status === "作废") ? "作废" : "在修"} />
      </div>

      <div className="field-grid">
        <FieldInput label="产地" value={carpet.origin} onCommit={(v) => commitField("origin", v)} />
        <FieldInput label="年代" value={carpet.era} onCommit={(v) => commitField("era", v)} />
        <FieldInput label="结密度" value={carpet.knotDensity} onCommit={(v) => commitField("knotDensity", v)} />
        <FieldInput label="材质" value={carpet.material} onCommit={(v) => commitField("material", v)} />
        <FieldInput label="染色类型" value={carpet.dyeType} onCommit={(v) => commitField("dyeType", v)} />
      </div>

      <h3>破损区域与纹样标记</h3>
      <div className="damage-grid">
        <PatternMap carpetNo={carpetNo} damages={damages} />
        <div className="damage-list">
          {damages.map((d) => (
            <div key={d.id} className="damage-row">
              <input
                className="damage-pos"
                value={d.position}
                onChange={(e) =>
                  s.commit({ kind: "damage", key: d.id, carpetNo, field: "position", value: e.target.value })
                }
              />
              <input
                className="damage-type"
                value={d.type}
                onChange={(e) =>
                  s.commit({ kind: "damage", key: d.id, carpetNo, field: "type", value: e.target.value })
                }
              />
              <input
                className="damage-size"
                value={d.size}
                placeholder="尺寸"
                onChange={(e) =>
                  s.commit({ kind: "damage", key: d.id, carpetNo, field: "size", value: e.target.value })
                }
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={d.marked}
                  onChange={(e) =>
                    s.commit({ kind: "damage", key: d.id, carpetNo, field: "marked", value: e.target.checked })
                  }
                />
                已标记
              </label>
            </div>
          ))}
          <button onClick={addDamage}>+ 添加破损区域</button>
        </div>
      </div>

      <h3>修复工序</h3>
      <div className="records">
        {processes.map((p) => (
          <article key={p.id} className={p.status === "作废" ? "proc-void" : ""}>
            <b className={p.status === "已完工" ? "bg-ok" : p.status === "作废" ? "bg-void" : ""}>
              {p.status === "已完工" ? "✓" : p.status === "作废" ? "!" : "…"}
            </b>
            <div className="proc-body">
              <div className="proc-head">
                <input
                  className="proc-name"
                  value={p.name}
                  onChange={(e) =>
                    s.commit({ kind: "process", key: p.id, carpetNo, field: "name", value: e.target.value })
                  }
                />
                <Badge value={p.status} />
              </div>
              {p.status === "作废" && <p className="void-reason">作废原因：{p.voidReason ?? "—"}（色卡复检/重算后恢复）</p>}
              <div className="proc-meta">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={p.checked}
                    onChange={(e) =>
                      s.commit({ kind: "process", key: p.id, carpetNo, field: "checked", value: e.target.checked })
                    }
                  />
                  复检已勾
                </label>
                <select
                  value={p.cardId ?? ""}
                  onChange={(e) =>
                    s.commit({
                      kind: "process",
                      key: p.id,
                      carpetNo,
                      field: "cardId",
                      value: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">未关联色卡</option>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} {c.name}（{c.status}）
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={p.status === "已完工" || p.status === "作废"}
                  onClick={() =>
                    s.commit({ kind: "process", key: p.id, carpetNo, field: "status", value: "已完工" as ProcessStatus })
                  }
                  title={p.status === "作废" ? "色卡作废中：复检通过后已勾工序仍可完工" : ""}
                >
                  标记完工
                </button>
              </div>
              <div className="rec-mini">
                {records
                  .filter((r) => r.processId === p.id)
                  .map((r) => (
                    <div key={r.id} className="rec-row">
                      <Badge value={r.status} />
                      <span className="rec-kind">{r.kind}</span>
                      <input
                        value={r.note}
                        placeholder="修复记录内容"
                        onChange={(e) =>
                          s.commit({ kind: "record", key: r.id, carpetNo, field: "note", value: e.target.value })
                        }
                      />
                    </div>
                  ))}
                <div className="rec-add">
                  <button onClick={() => addRecord(p.id, "修复前")}>+ 修复前</button>
                  <button onClick={() => addRecord(p.id, "修复后")}>+ 修复后</button>
                </div>
              </div>
            </div>
          </article>
        ))}
        <button onClick={addProcess}>+ 添加工序</button>
      </div>
    </div>
  );
}

/* ---------- 材料色卡 ---------- */

function CardsPanel() {
  const s = useStore();
  const cards = Object.values(s.draft.cards);
  const carpetNos = Object.keys(s.draft.carpets);
  const [draftDates, setDraftDates] = useState<Record<string, string>>({});

  const toggleScope = (card: ColorCard, no: string) => {
    const next = card.scope.includes(no)
      ? card.scope.filter((x) => x !== no)
      : [...card.scope, no];
    s.adjustCardScope(card.code, next);
  };

  return (
    <div className="records">
      <div className="heading">
        <div>
          <p>材料色卡</p>
          <h2>有效期与适用范围</h2>
        </div>
        <button className="primary" onClick={s.recalc}>
          一键作废重算
        </button>
      </div>
      {cards.map((c) => (
        <article key={c.code} className="card-row">
          <b className="swatch" style={{ background: c.hex }}>
            <span>{c.code}</span>
          </b>
          <div className="card-body">
            <div className="proc-head">
              <h3>
                {c.code} · {c.name}
              </h3>
              <Badge value={c.status} />
            </div>
            <p>
              有效期至 {c.validUntil || "—"} · 适用 {c.scope.length ? c.scope.join("、") : "全部地毯"}
            </p>
            <div className="scope-chips">
              {carpetNos.map((no) => (
                <button
                  key={no}
                  className={c.scope.includes(no) ? "chip-on" : ""}
                  onClick={() => toggleScope(c, no)}
                  title="点击调整适用范围，收窄后关联工序立即作废"
                >
                  {no}
                </button>
              ))}
            </div>
            {c.status !== "有效" && (
              <div className="reinspect">
                <input
                  type="date"
                  value={draftDates[c.code] ?? c.validUntil}
                  onChange={(e) => setDraftDates((p) => ({ ...p, [c.code]: e.target.value }))}
                />
                <button
                  className="primary"
                  onClick={() =>
                    s.reinspect(c.code, {
                      validUntil: draftDates[c.code] ?? c.validUntil,
                      scope: c.scope,
                    })
                  }
                >
                  复检通过（延期恢复）
                </button>
                <span className="hint">复检通过后：关联工序恢复，已勾工序仍可完工，修复记录重算</span>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

/* ---------- 冲突待确认 ---------- */

function ConflictsPanel() {
  const s = useStore();
  const conflicts = s.server.conflicts;
  const pending = conflicts.filter((c) => c.status === "待确认");
  const resolved = conflicts.filter((c) => c.status !== "待确认");
  return (
    <div className="records">
      {pending.length === 0 && (
        <p className="empty">没有待确认冲突。两边改了同一字段时，两版会留在这里。</p>
      )}
      {pending.map((c) => (
        <article key={c.id} className="conflict-row">
          <b className="bg-warn">!</b>
          <div className="conflict-body">
            <div className="proc-head">
              <h3>
                {KIND_LABEL[c.kind]} · {c.key}
                {c.carpetNo ? `（${c.carpetNo}）` : ""} · {c.label}
              </h3>
              <Badge value="待确认" />
            </div>
            <div className="conflict-versions">
              <div className="version version-remote">
                <span>服务端总档版（r{c.serverRev}）</span>
                <p>{fmt(c.serverValue)}</p>
              </div>
              <div className="version version-local">
                <span>平板离线版（基线 r{c.clientBaseRev}）</span>
                <p>{fmt(c.clientValue)}</p>
              </div>
            </div>
            <div className="conflict-actions">
              <button onClick={() => s.resolve(c.id, "remote")}>采用服务端版</button>
              <button className="primary" onClick={() => s.resolve(c.id, "local")}>
                采用平板版
              </button>
              <span className="hint">两版均已留档，采用后可在修订账中追溯</span>
            </div>
          </div>
        </article>
      ))}
      {resolved.map((c) => (
        <article key={c.id} className="conflict-row conflict-resolved">
          <b className="bg-ok">✓</b>
          <div className="conflict-body">
            <div className="proc-head">
              <h3>
                {KIND_LABEL[c.kind]} · {c.key} · {c.label}
              </h3>
              <Badge value={c.status} />
            </div>
            <p className="hint">
              总档 {fmt(c.serverValue)} → 平板 {fmt(c.clientValue)}（已留两版）
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ---------- 修订账 ---------- */

function LedgerPanel() {
  const s = useStore();
  const entries = useMemo(() => [...s.draft.ledger].reverse().slice(0, 40), [s.draft.ledger]);
  return (
    <div className="records">
      <p className="hint">
        续作修订账：离线内容按「档案键 + 字段」并回；同字段两边都改则留两版待确认；色卡过期/调范围立即作废重算；重复提交按 opId 幂等去重。
      </p>
      {entries.map((e) => (
        <article key={e.id} className={e.dedup ? "ledger-dedup" : ""}>
          <b className={e.source === "system" ? "bg-system" : e.dedup ? "bg-dedup" : ""}>
            {e.dedup ? "幂" : e.source === "system" ? "账" : "修"}
          </b>
          <div>
            <h3>
              r{e.rev} · {KIND_LABEL[e.kind]} · {e.key}
              {e.carpetNo ? `（${e.carpetNo}）` : ""} · {e.label}
              {e.dedup && <span className="tag tag-dedup">幂等去重</span>}
            </h3>
            <p>
              {e.oldValue !== undefined && (
                <>
                  <s>{fmt(e.oldValue)}</s> →{" "}
                </>
              )}
              {e.newValue !== undefined && <>{fmt(e.newValue)}</>}
              {e.note && <em className="ledger-note">{e.note}</em>}
            </p>
            <p className="ledger-meta">
              {e.source === "local" ? "平板离线" : e.source === "remote" ? "回网合并" : "系统级联"} ·{" "}
              {fmtTime(e.at)}
              {e.opId ? ` · ${e.opId.slice(0, 12)}` : ""}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ---------- 主界面 ---------- */

type Tab = "archive" | "cards" | "conflicts" | "ledger";

function Workbench() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>("archive");
  const [selected, setSelected] = useState("CAR-092");
  const [filter, setFilter] = useState("全部");

  const carpets = Object.values(s.draft.carpets);
  const origins = ["全部", ...Array.from(new Set(carpets.map((c) => c.origin)))];
  const shown = carpets.filter((c) => filter === "全部" || c.origin === filter);
  const conflictCount = s.server.conflicts.filter((c) => c.status === "待确认").length;

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "archive", label: "档案与工序" },
    { key: "cards", label: "材料色卡" },
    { key: "conflicts", label: "冲突待确认", badge: conflictCount },
    { key: "ledger", label: "续作修订账" },
  ];

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62009 · 续作修订账 · 离线合并 / 级联作废 / 断点续传</p>
        <h1>地毯修复纹样档案</h1>
        <span>
          库房断网时，修复师在平板记下破损区域、补线色卡与工序；回网后按「地毯编号 + 字段」并回总档。
          同一字段两边都改过就留两版待确认；色卡过期或范围调整，关联工序与修复前后记录立即作废重算；
          上传失败先留住已完成部分，恢复后只补未完成项，重复提交不生成第二份记录。
        </span>
      </section>

      <SyncBar />
      <Metrics />

      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab tab-on" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </button>
        ))}
        <button className="reset-btn" onClick={s.resetAll}>
          重置演示数据
        </button>
      </div>

      {tab === "archive" && (
        <section className="workspace">
          <aside className="panel">
            <h2>产地筛选</h2>
            <div className="chips">
              {origins.map((o) => (
                <button
                  key={o}
                  className={filter === o ? "chip-on" : ""}
                  onClick={() => setFilter(o)}
                >
                  {o}
                </button>
              ))}
            </div>
            <h2>档案列表</h2>
            <div className="carpet-list">
              {shown.map((c) => {
                const procs = Object.values(s.draft.processes).filter(
                  (p) => p.carpetNo === c.no,
                );
                const voided = procs.some((p) => p.status === "作废");
                return (
                  <button
                    key={c.no}
                    className={selected === c.no ? "carpet-item carpet-item-on" : "carpet-item"}
                    onClick={() => setSelected(c.no)}
                  >
                    <b>{c.no}</b>
                    <span>
                      {c.origin} · {c.era}
                    </span>
                    <span className="carpet-tags">
                      {voided ? <Badge value="作废" /> : <Badge value="在修" />}
                      {s.outbox.some(
                        (o) => o.carpetNo === c.no || (o.kind === "carpet" && o.key === c.no),
                      ) && <Badge value="待上传" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="panel form-panel">
            <CarpetDetail carpetNo={selected} />
          </section>
        </section>
      )}

      {tab === "cards" && (
        <section className="panel">
          <CardsPanel />
        </section>
      )}

      {tab === "conflicts" && (
        <section className="panel">
          <ConflictsPanel />
        </section>
      )}

      {tab === "ledger" && (
        <section className="panel">
          <LedgerPanel />
        </section>
      )}
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workbench />
    </StoreProvider>
  );
}
