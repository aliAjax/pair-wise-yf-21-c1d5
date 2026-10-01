import { useStore } from "../store";
import { fmtTime } from "../utils";

export default function LogPanel() {
  const { logs } = useStore();

  return (
    <section className="panel log-panel">
      <div className="heading">
        <div>
          <p>同步与级联日志</p>
          <h2>修订账流水</h2>
        </div>
      </div>
      <ul className="logs">
        {logs.map((log) => (
          <li key={log.id} className={`log log-${log.level}`}>
            <time>{fmtTime(log.time)}</time>
            <span>{log.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
