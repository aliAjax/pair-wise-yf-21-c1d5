import { cardEffective } from "../engine";
import { useStore } from "../store";
import { daysUntil, todayStr } from "../utils";

export default function ColorCards() {
  const { server, submit } = useStore();
  const now = Date.now();

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>材料色卡</p>
          <h2>补线色卡与复检</h2>
        </div>
        <small className="muted">过期 / 范围调整后，关联工序与前后记录立即作废重算</small>
      </div>

      <div className="card-grid">
        {server.cards.map((card) => {
          const effective = cardEffective(card, now);
          const days = daysUntil(card.validUntil);
          const linked = server.procedures.filter(
            (p) => p.cardId === card.id && p.status !== "voided" && p.status !== "done"
          );

          return (
            <article key={card.id} className={`color-card ${effective ? "" : "card-dead"}`}>
              <div className="swatch" style={{ background: card.colorHex }} />
              <div className="color-info">
                <h4>
                  {card.colorName}
                  <em className={effective ? "badge badge-ok" : "badge badge-danger"}>
                    {effective ? (days <= 14 ? `${days <= 0 ? "今日到期" : `${days}天后到期`}` : "有效") : "已过期"}
                  </em>
                  <em className="badge badge-gray">v{card.version}</em>
                </h4>
                <p>
                  {card.material} · {card.dyeSource}
                </p>
                <p className="range-line">
                  适用范围：<b>{card.range}</b>
                </p>
                <p className="muted">
                  有效期至 {card.validUntil}
                  {card.updatedReason ? ` · ${card.updatedReason}` : ""}
                </p>
                <p className="muted">
                  在做工序 {linked.length} 道
                  {linked.length > 0 ? `：${linked.map((p) => p.name).join("、")}` : ""}
                </p>

                <div className="card-actions">
                  {effective ? (
                    <>
                      <button
                        className="small danger-btn"
                        onClick={() => {
                          const reason = window.prompt("复检结论（为何判定过期）：", "复检色差 ΔE 超标，停止使用");
                          if (reason !== null) {
                            submit("cardExpire", { cardId: card.id, reason: reason || "复检不合格" });
                          }
                        }}
                      >
                        复检判过期
                      </button>
                      <button
                        className="small"
                        onClick={() => {
                          const range = window.prompt("新的适用范围：", card.range);
                          if (range !== null && range.trim()) {
                            submit("cardRange", {
                              cardId: card.id,
                              newRange: range.trim(),
                              reason: "本批次色线适用纹样范围调整",
                            });
                          }
                        }}
                      >
                        调整适用范围
                      </button>
                    </>
                  ) : (
                    <button
                      className="small primary"
                      onClick={() => {
                        const d = window.prompt("复检合格后的新有效期（YYYY-MM-DD）：", "2027-06-30") || todayStr();
                        submit("cardRecertify", {
                          cardId: card.id,
                          newValidUntil: d,
                          reason: "重新染色复检合格",
                        });
                      }}
                    >
                      复检合格重新启用
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
