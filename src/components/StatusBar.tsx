import { useStore } from "../store";

export default function StatusBar() {
  const {
    online,
    setOnline,
    syncing,
    failNextN,
    armFailures,
    outbox,
    resetAll,
  } = useStore();

  const pending = outbox.filter(
    (i) => i.status === "pending" || i.status === "failed"
  ).length;
  const failed = outbox.filter((i) => i.status === "failed").length;

  return (
    <div className="statusbar">
      <div className={`net-dot ${online ? "on" : "off"}`}>
        <span className="pulse" />
        {online ? "总档在线" : "库房断网 · 平板模式"}
      </div>

      <div className="net-actions">
        <button
          className={online ? "" : "active-warn"}
          onClick={() => setOnline(!online)}
        >
          {online ? "✈ 模拟断网" : "↻ 恢复联网"}
        </button>
        <button
          className={failNextN > 0 ? "active-warn" : ""}
          onClick={() => armFailures(failNextN > 0 ? 0 : 1)}
          title="让下一次上传失败，用于验证断点续传"
        >
          {failNextN > 0 ? `弱网中(${failNextN})` : "⚡ 模拟上传失败"}
        </button>
        <button onClick={resetAll} title="清空本地数据回到初始演示档">
          重置演示
        </button>
      </div>

      <div className="sync-hint">
        {syncing ? (
          <span className="hint-info">正在按顺序回补……</span>
        ) : pending > 0 ? (
          <span className={failed > 0 ? "hint-danger" : "hint-warn"}>
            {failed > 0
              ? `${failed} 笔失败中断，已完成部分保留，恢复后只补未完成项（待补 ${pending} 笔）`
              : `待传 ${pending} 笔${online ? "，即将自动回补" : "，断网期间安全留存"}`}
          </span>
        ) : (
          <span className="hint-ok">平板与总档一致，无待补内容</span>
        )}
      </div>
    </div>
  );
}
