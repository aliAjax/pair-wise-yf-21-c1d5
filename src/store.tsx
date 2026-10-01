// 总档/平板状态容器：离线草稿、逐条上传、断点续传、幂等补传
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Op, ServerState } from "./types";
import {
  adjustScope,
  applyOp,
  evaluateCards,
  recalcAll,
  reinspectCard,
  resolveConflict,
} from "./engine";
import { seedState } from "./seed";

const SERVER_KEY = "rev-ledger:server:v1";
const CLIENT_KEY = "rev-ledger:client:v1";

interface ClientPersist {
  clientId: string;
  outbox: Op[];
  lastSyncRev: number;
  online: boolean;
  weakNetwork: boolean;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadServer(): ServerState {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) return JSON.parse(raw) as ServerState;
  } catch {
    /* ignore */
  }
  const s = seedState();
  localStorage.setItem(SERVER_KEY, JSON.stringify(s));
  return s;
}

function loadClient(): ClientPersist {
  try {
    const raw = localStorage.getItem(CLIENT_KEY);
    if (raw) return JSON.parse(raw) as ClientPersist;
  } catch {
    /* ignore */
  }
  return {
    clientId: `tab-${uid()}`,
    outbox: [],
    lastSyncRev: 0,
    online: true,
    weakNetwork: false,
  };
}

/** 草稿 = 总档快照 + 本地未上传操作（乐观合并），再跑一次色卡级联 */
function buildDraft(snapshot: ServerState, outbox: Op[]): ServerState {
  const d = structuredClone(snapshot);
  for (const op of outbox) applyOp(d, op, "local");
  evaluateCards(d);
  return d;
}

interface StoreValue {
  draft: ServerState; // 界面渲染用（含本地未上传改动）
  server: ServerState; // 服务端总档
  outbox: Op[];
  online: boolean;
  weakNetwork: boolean;
  syncing: boolean;
  error: string | null;
  lastUploaded: number;
  commit: (op: Omit<Op, "opId" | "clientId" | "baseRev" | "at">) => void;
  syncNow: () => Promise<void>;
  demoDuplicateSubmit: () => Promise<void>;
  toggleOnline: () => void;
  toggleWeak: () => void;
  resolve: (conflictId: string, choice: "local" | "remote") => void;
  recalc: () => void;
  reinspect: (code: string, patch: { validUntil?: string; scope?: string[] }) => void;
  adjustCardScope: (code: string, scope: string[]) => void;
  resetAll: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<ServerState>(loadServer);
  const [client, setClient] = useState<ClientPersist>(loadClient);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUploaded, setLastUploaded] = useState(0);

  const serverRef = useRef(server);
  serverRef.current = server;
  const clientRef = useRef(client);
  clientRef.current = client;
  const lastBatchRef = useRef<Op[]>([]);

  const persist = useCallback((s: ServerState, c: ClientPersist) => {
    localStorage.setItem(SERVER_KEY, JSON.stringify(s));
    localStorage.setItem(CLIENT_KEY, JSON.stringify(c));
  }, []);

  const draft = useMemo(
    () => buildDraft(server, client.outbox),
    [server, client.outbox],
  );

  /** 本地提交：进离线草稿箱，baseRev 取该字段当前草稿修订 */
  const commit = useCallback(
    (partial: Omit<Op, "opId" | "clientId" | "baseRev" | "at">) => {
      setClient((prev) => {
        const d = buildDraft(serverRef.current, prev.outbox);
        const id = `${partial.kind}:${partial.key}:${partial.field}`;
        const baseRev = d.fields[id]?.rev ?? prev.lastSyncRev;
        const op: Op = {
          ...partial,
          opId: `op-${uid()}`,
          clientId: prev.clientId,
          baseRev,
          at: Date.now(),
        };
        return { ...prev, outbox: [...prev.outbox, op] };
      });
    },
    [],
  );

  /** 逐条上传：每条确认后立即 checkpoint；失败留住已完成部分，恢复只补未完成项 */
  const syncNow = useCallback(async () => {
    const c0 = clientRef.current;
    if (!c0.online) {
      setError("当前为断网状态：平板内容已留在本机，恢复网络后即可补传。");
      return;
    }
    if (syncing) return;
    setSyncing(true);
    setError(null);
    const s = serverRef.current;
    const c: ClientPersist = {
      ...c0,
      outbox: [...c0.outbox],
    };
    const batch = [...c.outbox];
    lastBatchRef.current = batch;
    let uploaded = 0;
    try {
      for (const op of batch) {
        await new Promise((r) => setTimeout(r, 180 + Math.random() * 260));
        if (c.weakNetwork && Math.random() < 0.35) {
          throw new Error("网络中断");
        }
        applyOp(s, op, "remote");
        c.outbox = c.outbox.filter((o) => o.opId !== op.opId);
        c.lastSyncRev = s.rev;
        uploaded++;
        setLastUploaded(uploaded);
        persist(s, c); // checkpoint：已确认条目立即落盘
      }
      evaluateCards(s);
      c.lastSyncRev = s.rev;
      persist(s, c);
      setServer(structuredClone(s));
      setClient({ ...c });
    } catch (e) {
      // 中断：已上传条目已确认并落盘，outbox 中只剩未完成项
      c.lastSyncRev = s.rev;
      persist(s, c);
      setServer(structuredClone(s));
      setClient({ ...c });
      setError(
        `上传中断：已完成 ${uploaded} 条并留住，恢复后只补未完成的 ${c.outbox.length} 条（${
          (e as Error).message
        }），重复提交不会生成第二份记录。`,
      );
    } finally {
      setSyncing(false);
    }
  }, [syncing, persist]);

  /** 演示：同一批操作重复提交 → 服务端按 opId 幂等去重，不产生第二份记录 */
  const demoDuplicateSubmit = useCallback(async () => {
    if (!clientRef.current.online) {
      setError("断网状态下无法演示重复提交。");
      return;
    }
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const s = serverRef.current;
      const batch = lastBatchRef.current;
      let dedup = 0;
      for (const op of batch) {
        const r = applyOp(s, op, "remote");
        if (r.result === "dedup") dedup++;
      }
      evaluateCards(s);
      persist(s, clientRef.current);
      setServer(structuredClone(s));
      setError(`重复提交演示：${dedup} 条全部命中幂等去重，未生成第二份记录。`);
    } finally {
      setSyncing(false);
    }
  }, [syncing, persist]);

  const toggleOnline = useCallback(() => {
    setClient((prev) => {
      const next = { ...prev, online: !prev.online };
      persist(serverRef.current, next);
      return next;
    });
  }, [persist]);

  const toggleWeak = useCallback(() => {
    setClient((prev) => {
      const next = { ...prev, weakNetwork: !prev.weakNetwork };
      persist(serverRef.current, next);
      return next;
    });
  }, [persist]);

  const resolve = useCallback(
    (conflictId: string, choice: "local" | "remote") => {
      if (!clientRef.current.online) {
        setError("冲突需在联网状态下解决，结果将回写服务端总档。");
        return;
      }
      const s = serverRef.current;
      resolveConflict(s, conflictId, choice);
      evaluateCards(s);
      persist(s, clientRef.current);
      setServer(structuredClone(s));
    },
    [persist],
  );

  const recalc = useCallback(() => {
    const s = serverRef.current;
    recalcAll(s);
    evaluateCards(s);
    persist(s, clientRef.current);
    setServer(structuredClone(s));
  }, [persist]);

  const reinspect = useCallback(
    (code: string, patch: { validUntil?: string; scope?: string[] }) => {
      const s = serverRef.current;
      reinspectCard(s, code, patch);
      evaluateCards(s);
      persist(s, clientRef.current);
      setServer(structuredClone(s));
    },
    [persist],
  );

  const adjustCardScope = useCallback(
    (code: string, scope: string[]) => {
      const s = serverRef.current;
      adjustScope(s, code, scope);
      evaluateCards(s);
      persist(s, clientRef.current);
      setServer(structuredClone(s));
    },
    [persist],
  );

  const resetAll = useCallback(() => {
    localStorage.removeItem(SERVER_KEY);
    localStorage.removeItem(CLIENT_KEY);
    const s = seedState();
    setServer(s);
    setClient(loadClient());
    setError(null);
    lastBatchRef.current = [];
  }, []);

  const value: StoreValue = {
    draft,
    server,
    outbox: client.outbox,
    online: client.online,
    weakNetwork: client.weakNetwork,
    syncing,
    error,
    lastUploaded,
    commit,
    syncNow,
    demoDuplicateSubmit,
    toggleOnline,
    toggleWeak,
    resolve,
    recalc,
    reinspect,
    adjustCardScope,
    resetAll,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
