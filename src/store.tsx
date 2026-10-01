import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { applyOp, type EngineState } from "./engine";
import { createSeedState } from "./seed";
import type {
  Carpet,
  ClientOp,
  FieldKey,
  LogEntry,
  LogLevel,
  OpResult,
  OutboxItem,
} from "./types";
import { clone, fmtTime, uid } from "./utils";

const STORAGE_KEY = "rug-repair-ledger-v1";
const NET_LATENCY_MS = 320;

interface PersistShape {
  server: EngineState;
  outbox: OutboxItem[];
  logs: LogEntry[];
  online: boolean;
  failNextN: number;
}

export interface StoreValue {
  server: EngineState;
  outbox: OutboxItem[];
  logs: LogEntry[];
  online: boolean;
  syncing: boolean;
  failNextN: number;
  selectedCarpetId: string;
  setSelectedCarpetId: (id: string) => void;
  /** 提交一笔操作：离线进队列，在线立即同步 */
  submit: (type: ClientOp["type"], payload: ClientOp["payload"]) => void;
  /** 把同字段的离线编辑合并到已有待传项（避免重复传），无则新建 */
  submitFieldEdit: (carpetId: string, field: FieldKey, newValue: string) => void;
  syncNow: () => void;
  /** 演示：重新发送一笔已完成的操作，验证幂等不产生第二份记录 */
  resendDone: (opId: string) => void;
  clearDone: () => void;
  setOnline: (online: boolean) => void;
  /** 安排接下来 n 次网络请求失败（弱网/上传中断演示） */
  armFailures: (n: number) => void;
  /** 演示：在离线期间制造“总档那边也改了”的并发修改 */
  simulateRemoteEdit: (carpetId: string, field: FieldKey, value: string) => void;
  resetAll: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

function freshState(): PersistShape {
  const now = Date.now();
  return {
    server: createSeedState(now),
    outbox: [],
    logs: [
      {
        id: uid("log"),
        time: now,
        level: "info",
        message: "总档已载入：3 条地毯档案、3 张色卡、3 道工序",
      },
    ],
    online: true,
    failNextN: 0,
  };
}

function load(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as PersistShape;
    if (!parsed.server?.carpets) return freshState();
    return parsed;
  } catch {
    return freshState();
  }
}

function sameFieldKey(
  op: OutboxItem,
  carpetId: string,
  field: FieldKey
): boolean {
  return (
    op.type === "fieldEdit" &&
    (op.payload as { carpetId: string; field: FieldKey }).carpetId === carpetId &&
    (op.payload as { carpetId: string; field: FieldKey }).field === field
  );
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const initial = useRef<PersistShape | undefined>(undefined);
  if (!initial.current) initial.current = load();

  const [server, setServer] = useState<EngineState>(initial.current.server);
  const [outbox, setOutbox] = useState<OutboxItem[]>(initial.current.outbox);
  const [logs, setLogs] = useState<LogEntry[]>(initial.current.logs);
  const [online, setOnlineState] = useState<boolean>(initial.current.online);
  const [failNextN, setFailNextN] = useState<number>(initial.current.failNextN);
  const [syncing, setSyncing] = useState(false);
  const [selectedCarpetId, setSelectedCarpetId] = useState(
    initial.current.server.carpets[0]?.id ?? ""
  );

  const syncingRef = useRef(false);
  const onlineRef = useRef(online);
  const failRef = useRef(failNextN);
  const serverRef = useRef(server);
  const outboxRef = useRef(outbox);
  onlineRef.current = online;
  failRef.current = failNextN;
  serverRef.current = server;
  outboxRef.current = outbox;

  // 持久化（留住已完成部分：刷新页面后队列与总档都在）
  useEffect(() => {
    const data: PersistShape = { server, outbox, logs, online, failNextN };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 存储满时忽略，本轮会话仍可继续 */
    }
  }, [server, outbox, logs, online, failNextN]);

  const addLog = useCallback((level: LogLevel, message: string) => {
    setLogs((prev) =>
      [{ id: uid("log"), time: Date.now(), level, message }, ...prev].slice(0, 120)
    );
  }, []);

  const submit = useCallback(
    (type: ClientOp["type"], payload: ClientOp["payload"]) => {
      const op: OutboxItem = {
        opId: uid("op"),
        type,
        time: Date.now(),
        payload: clone(payload),
        status: "pending",
        attempts: 0,
      };
      setOutbox((prev) => [...prev, op]);
      if (!onlineRef.current) {
        addLog("warn", `离线：操作已存入平板待传队列（${type}）`);
      }
    },
    [addLog]
  );

  const submitFieldEdit = useCallback(
    (carpetId: string, field: FieldKey, newValue: string) => {
      const carpet = server.carpets.find((c) => c.id === carpetId);
      if (!carpet) return;
      const baseValue = (() => {
        if (field.startsWith("damage:")) {
          const id = field.slice("damage:".length);
          return carpet.damages.find((d) => d.id === id)?.note ?? "";
        }
        return String(carpet[field as keyof Carpet]);
      })();

      setOutbox((prev) => {
        // 同一字段离线多次修改：只保留最新值，仍以最初的总档值为 base
        const existing = prev.find(
          (item) =>
            (item.status === "pending" || item.status === "failed") &&
            sameFieldKey(item, carpetId, field)
        );
        if (existing) {
          return prev.map((item) =>
            item === existing
              ? {
                  ...item,
                  time: Date.now(),
                  payload: { carpetId, field, baseValue, newValue },
                }
              : item
          );
        }
        const op: OutboxItem = {
          opId: uid("op"),
          type: "fieldEdit",
          time: Date.now(),
          payload: { carpetId, field, baseValue, newValue },
          status: "pending",
          attempts: 0,
        };
        return [...prev, op];
      });
      if (!onlineRef.current) {
        addLog("warn", `离线：「${carpet.carpetNo}」字段改动已暂存，回网后按字段并回`);
      }
    },
    [server.carpets, addLog]
  );

  const resendDone = useCallback(
    (opId: string) => {
      setOutbox((prev) => {
        const target = prev.find((item) => item.opId === opId);
        if (!target || target.status !== "done") return prev;
        addLog(
          "info",
          `重复提交 opId=${opId.slice(-6)}（服务端将幂等去重，不生成第二份记录）`
        );
        // 复制成一条新的待传项，但沿用原 opId —— 这正是“重复提交”
        const retry: OutboxItem = {
          ...target,
          status: "pending",
          attempts: 0,
          lastAttemptAt: undefined,
          error: undefined,
        };
        return [...prev, retry];
      });
    },
    [addLog]
  );

  const clearDone = useCallback(() => {
    setOutbox((prev) => prev.filter((item) => item.status !== "done"));
  }, []);

  const setOnline = useCallback(
    (next: boolean) => {
      setOnlineState(next);
      if (next) {
        addLog("success", "网络恢复，开始回补未完成项……");
      } else {
        addLog("warn", "库房断网：所有改动进入平板待传队列，不丢内容");
      }
    },
    [addLog]
  );

  const armFailures = useCallback(
    (n: number) => {
      setFailNextN(n);
      if (n > 0) addLog("warn", `已设置弱网：接下来 ${n} 次上传将失败（用于验证断点续传）`);
    },
    [addLog]
  );

  const simulateRemoteEdit = useCallback(
    (carpetId: string, field: FieldKey, value: string) => {
      // 直接改“服务端总档”，模拟离线期间同事在别的终端的修改
      setServer((prev) => {
        const next = clone(prev) as EngineState;
        const carpet = next.carpets.find((c) => c.id === carpetId);
        if (!carpet) return prev;
        if (field.startsWith("damage:")) {
          const id = field.slice("damage:".length);
          const damage = carpet.damages.find((d) => d.id === id);
          if (damage) damage.note = value;
        } else {
          (carpet as unknown as Record<string, string>)[field] = value;
        }
        carpet.updatedAt = Date.now();
        return next;
      });
      addLog("info", "（演示）总档被其他终端修改，制造与离线补录的同字段并发");
    },
    [addLog]
  );

  const resetAll = useCallback(() => {
    const fresh = freshState();
    setServer(fresh.server);
    setOutbox(fresh.outbox);
    setLogs(fresh.logs);
    setOnlineState(true);
    setFailNextN(0);
    setSelectedCarpetId(fresh.server.carpets[0].id);
    syncingRef.current = false;
    setSyncing(false);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // ---- 同步循环：顺序发送，失败处中断，已完成项全部保留 -------------------
  const syncNow = useCallback(() => {
    if (syncingRef.current || !onlineRef.current) return;
    const queue = outboxRef.current.filter(
      (item) => item.status === "pending" || item.status === "failed"
    );
    if (queue.length === 0) return;

    syncingRef.current = true;
    setSyncing(true);

    const reportResult = (item: OutboxItem, result: OpResult) => {
      if (!result.ok) {
        // 业务校验失败：标记 rejected，不阻塞后续队列
        setOutbox((prev) =>
          prev.map((x) =>
            x.opId === item.opId
              ? {
                  ...x,
                  status: "rejected",
                  error: result.message,
                  lastAttemptAt: Date.now(),
                }
              : x
          )
        );
        addLog("danger", `操作被总档拒收：${result.message}`);
        return;
      }
      if (result.duplicate) {
        addLog(
          "info",
          `幂等命中：opId=${item.opId.slice(-6)} 已处理过，未生成第二份记录`
        );
        return;
      }
      if (result.conflict) {
        addLog(
          "warn",
          "同一字段两边都改过：已留两版到修订账，等待人工确认，未做覆盖"
        );
      }
      if (result.cascade) {
        const c = result.cascade;
        addLog(
          "danger",
          `色卡失效级联：作废工序 ${c.voidedProcs} 道、关联修复记录 ${c.voidedRecords} 条，已生成重算工序 ${c.newProcs} 道`
        );
      }
    };

    const finish = () => {
      syncingRef.current = false;
      setSyncing(false);
    };

    const step = (index: number) => {
      if (index >= queue.length) {
        addLog("success", `本轮回补完成：共发送 ${queue.length} 笔`);
        finish();
        return;
      }
      const item = queue[index];

      // 模拟弱网：该笔请求整体失败（服务端没收到 / 响应丢失）
      if (failRef.current > 0) {
        setFailNextN((n) => Math.max(0, n - 1));
        const error = "上传失败：库房网络抖动（模拟）";
        setOutbox((prev) =>
          prev.map((x) =>
            x.opId === item.opId
              ? {
                  ...x,
                  status: "failed",
                  attempts: x.attempts + 1,
                  lastAttemptAt: Date.now(),
                  error,
                }
              : x
          )
        );
        addLog(
          "danger",
          `第 ${index + 1}/${queue.length} 笔上传失败，前 ${index} 笔已留住；未完成项保持待补`
        );
        finish();
        return; // 中断：后面的项目原样 pending，恢复后只补这些
      }

      window.setTimeout(() => {
        // 在事件处理层对最新总档应用操作，避免 setState 更新函数里产生副作用
        const { state: nextServer, result } = applyOp(
          serverRef.current,
          item,
          Date.now()
        );

        if (result.ok) {
          setServer(nextServer);
          serverRef.current = nextServer;
          setOutbox((prev) =>
            prev.map((x) =>
              x.opId === item.opId
                ? {
                    ...x,
                    status: "done",
                    attempts: x.attempts + 1,
                    lastAttemptAt: Date.now(),
                    error: undefined,
                  }
                : x
            )
          );
        }
        reportResult(item, result);
        window.setTimeout(() => step(index + 1), 60);
      }, NET_LATENCY_MS);
    };

    step(0);
  }, [addLog]);

  // 在线时自动同步（入队、重连、失败计数归零后触发）
  const pendingCount = outbox.filter(
    (i) => i.status === "pending" || i.status === "failed"
  ).length;
  useEffect(() => {
    if (online && pendingCount > 0 && !syncing) {
      const t = window.setTimeout(() => syncNow(), 120);
      return () => window.clearTimeout(t);
    }
  }, [online, pendingCount, syncing, outbox, syncNow]);

  const value = useMemo<StoreValue>(
    () => ({
      server,
      outbox,
      logs,
      online,
      syncing,
      failNextN,
      selectedCarpetId,
      setSelectedCarpetId,
      submit,
      submitFieldEdit,
      syncNow,
      resendDone,
      clearDone,
      setOnline,
      armFailures,
      simulateRemoteEdit,
      resetAll,
    }),
    [
      server,
      outbox,
      logs,
      online,
      syncing,
      failNextN,
      selectedCarpetId,
      submit,
      submitFieldEdit,
      syncNow,
      resendDone,
      clearDone,
      setOnline,
      armFailures,
      simulateRemoteEdit,
      resetAll,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore 必须在 StoreProvider 内使用");
  return ctx;
}

export { fmtTime };
