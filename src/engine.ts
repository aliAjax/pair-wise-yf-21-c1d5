// 续作修订账引擎：字段级合并 + 冲突留两版 + 色卡级联作废/重算
import type {
  BeforeAfterRecord,
  Carpet,
  ColorCard,
  Conflict,
  DamageArea,
  Kind,
  LedgerEntry,
  Op,
  ProcessStatus,
  RepairProcess,
  ServerState,
} from "./types";

export const fieldKey = (kind: Kind, key: string, field: string): string =>
  `${kind}:${key}:${field}`;

export const LABELS: Record<Kind, Record<string, string>> = {
  carpet: {
    "*": "地毯档案",
    origin: "产地",
    era: "年代",
    knotDensity: "结密度",
    material: "材质",
    dyeType: "染色类型",
  },
  damage: {
    "*": "破损区域",
    position: "位置",
    type: "破损类型",
    size: "尺寸",
    marked: "纹样标记",
  },
  card: {
    "*": "材料色卡",
    code: "色卡号",
    name: "颜色名",
    hex: "色值",
    scope: "适用范围",
    validUntil: "有效期至",
    status: "状态",
  },
  process: {
    "*": "修复工序",
    name: "工序名称",
    cardId: "关联色卡",
    checked: "复检勾选",
    status: "工序状态",
    voidReason: "作废原因",
  },
  record: {
    "*": "修复前后记录",
    processId: "关联工序",
    kind: "记录类别",
    note: "记录内容",
    status: "记录状态",
  },
};

export function labelFor(kind: Kind, field: string): string {
  return LABELS[kind]?.[field] ?? field;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushLedger(
  state: ServerState,
  entry: Omit<LedgerEntry, "id" | "rev" | "label"> & {
    rev?: number;
    label?: string;
  },
): void {
  const rev = entry.rev ?? ++state.rev;
  state.ledger.push({
    id: `lg-${rev}-${state.ledger.length}`,
    rev,
    kind: entry.kind,
    key: entry.key,
    carpetNo: entry.carpetNo,
    field: entry.field,
    label: entry.label ?? labelFor(entry.kind, entry.field),
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    source: entry.source,
    opId: entry.opId,
    note: entry.note,
    dedup: entry.dedup,
    at: entry.at,
  });
}

function getEntity(
  state: ServerState,
  kind: Kind,
  key: string,
): Record<string, unknown> | undefined {
  if (kind === "carpet") return state.carpets[key] as unknown as Record<string, unknown> | undefined;
  if (kind === "damage") return state.damages[key] as unknown as Record<string, unknown> | undefined;
  if (kind === "card") return state.cards[key] as unknown as Record<string, unknown> | undefined;
  if (kind === "process") return state.processes[key] as unknown as Record<string, unknown> | undefined;
  if (kind === "record") return state.records[key] as unknown as Record<string, unknown> | undefined;
  return undefined;
}

/** 把字段值落到实体上（"*" 为整条档案写入，不存在则新建） */
function materialize(state: ServerState, op: Op): void {
  if (op.field === "*") {
    const value = op.value;
    if (op.kind === "carpet") state.carpets[op.key] = value as Carpet;
    else if (op.kind === "damage") state.damages[op.key] = value as DamageArea;
    else if (op.kind === "card") state.cards[op.key] = value as ColorCard;
    else if (op.kind === "process") state.processes[op.key] = value as RepairProcess;
    else if (op.kind === "record") state.records[op.key] = value as BeforeAfterRecord;
    return;
  }
  const entity = getEntity(state, op.kind, op.key);
  if (entity) (entity as Record<string, unknown>)[op.field] = op.value;
}

/**
 * 应用一条操作（幂等）。
 * - opId 已存在 → 直接返回 dedup，绝不写第二份
 * - 字段当前写入方就是本客户端 → 自己的连续写入，直接应用
 * - 字段当前修订 <= 客户端基线 → 客户端基于最新版，直接应用
 * - 否则两边都改过且值不同 → 留两版待确认，不覆盖
 */
export function applyOp(
  state: ServerState,
  op: Op,
  source: "local" | "remote",
): { result: "applied" | "dedup" | "conflict"; conflict?: Conflict } {
  const now = Date.now();

  if (state.appliedOpIds[op.opId]) {
    pushLedger(state, {
      kind: op.kind,
      key: op.key,
      carpetNo: op.carpetNo,
      field: op.field,
      newValue: op.value,
      source,
      opId: op.opId,
      note: "幂等去重：重复提交未写入第二份记录",
      dedup: true,
      at: now,
    });
    return { result: "dedup" };
  }

  const id = fieldKey(op.kind, op.key, op.field);
  const cur = state.fields[id];

  if (!cur) {
    state.fields[id] = {
      value: op.value,
      rev: ++state.rev,
      baseRev: op.baseRev,
      writerId: op.clientId,
    };
    materialize(state, op);
    state.appliedOpIds[op.opId] = { rev: state.rev, result: "applied", at: now };
    pushLedger(state, {
      rev: state.rev,
      kind: op.kind,
      key: op.key,
      carpetNo: op.carpetNo,
      field: op.field,
      oldValue: undefined,
      newValue: op.value,
      source,
      opId: op.opId,
      at: now,
    });
    return { result: "applied" };
  }

  const ownWrite = cur.writerId === op.clientId;
  if (ownWrite || cur.rev <= op.baseRev) {
    if (!deepEqual(cur.value, op.value)) {
      const oldValue = cur.value;
      cur.value = op.value;
      cur.baseRev = op.baseRev;
      cur.rev = ++state.rev;
      cur.writerId = op.clientId;
      materialize(state, op);
      pushLedger(state, {
        rev: state.rev,
        kind: op.kind,
        key: op.key,
        carpetNo: op.carpetNo,
        field: op.field,
        oldValue,
        newValue: op.value,
        source,
        opId: op.opId,
        at: now,
      });
    }
    state.appliedOpIds[op.opId] = { rev: cur.rev, result: "applied", at: now };
    return { result: "applied" };
  }

  // 服务端在客户端基线之后改过同一字段 → 两边都改了
  if (deepEqual(cur.value, op.value)) {
    state.appliedOpIds[op.opId] = { rev: cur.rev, result: "applied", at: now };
    return { result: "applied" };
  }

  const conflict: Conflict = {
    id: `cf-${op.opId}`,
    kind: op.kind,
    key: op.key,
    carpetNo: op.carpetNo,
    field: op.field,
    label: labelFor(op.kind, op.field),
    serverValue: cur.value,
    clientValue: op.value,
    serverRev: cur.rev,
    clientBaseRev: op.baseRev,
    status: "待确认",
    opId: op.opId,
    at: now,
  };
  state.conflicts.push(conflict);
  state.appliedOpIds[op.opId] = { rev: cur.rev, result: "conflict", at: now };
  pushLedger(state, {
    rev: ++state.rev,
    kind: op.kind,
    key: op.key,
    carpetNo: op.carpetNo,
    field: op.field,
    oldValue: cur.value,
    newValue: op.value,
    source: "system",
    note: `同一字段两边都改过：留两版待确认（总档 r${cur.rev} / 平板基线 r${op.baseRev}）`,
    at: now,
  });
  return { result: "conflict", conflict };
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 色卡失效：关联工序作废、修复前后记录置待重算。
 * mode: "all" 过期 → 全部关联工序作废；"excluded" 范围调整 → 仅作废不再被覆盖的工序 */
function voidForCard(
  state: ServerState,
  card: ColorCard,
  reason: string,
  mode: "all" | "excluded",
): void {
  const affected = (p: RepairProcess): boolean => {
    if (p.cardId !== card.id || p.status === "作废") return false;
    if (mode === "all") return true;
    return !card.scope.includes(p.carpetNo);
  };
  for (const p of Object.values(state.processes)) {
    if (!affected(p)) continue;
    const old = p.status;
    p.status = "作废";
    p.voidReason = reason;
    pushLedger(state, {
      rev: ++state.rev,
      kind: "process",
      key: p.id,
      carpetNo: p.carpetNo,
      field: "status",
      oldValue: old,
      newValue: "作废",
      source: "system",
      note: `${reason}：关联工序立即作废`,
      at: Date.now(),
    });
  }
  for (const r of Object.values(state.records)) {
    const p = state.processes[r.processId];
    if (!p || r.status === "待重算") continue;
    // 记录所属工序已作废（或因范围调整不再被该色卡覆盖）→ 待重算
    const voided =
      p.cardId === card.id &&
      (mode === "all" ? p.status === "作废" : !card.scope.includes(p.carpetNo));
    if (!voided) continue;
    const old = r.status;
    r.status = "待重算";
    pushLedger(state, {
      rev: ++state.rev,
      kind: "record",
      key: r.id,
      carpetNo: r.carpetNo,
      field: "status",
      oldValue: old,
      newValue: "待重算",
      source: "system",
      note: `${reason}：修复前后记录作废，待重算`,
      at: Date.now(),
    });
  }
}

/** 色卡复检通过：作废工序恢复，已勾工序仍可完工；记录重算 */
function restoreForCard(state: ServerState, card: ColorCard): void {
  for (const p of Object.values(state.processes)) {
    if (p.cardId !== card.id || p.status !== "作废") continue;
    const old = p.status;
    const next: ProcessStatus = p.checked ? "已完工" : "进行中";
    p.status = next;
    p.voidReason = undefined;
    pushLedger(state, {
      rev: ++state.rev,
      kind: "process",
      key: p.id,
      carpetNo: p.carpetNo,
      field: "status",
      oldValue: old,
      newValue: next,
      source: "system",
      note: p.checked
        ? "复检通过：已勾工序仍能完工，恢复为已完工"
        : "复检通过：工序恢复进行中",
      at: Date.now(),
    });
  }
  for (const r of Object.values(state.records)) {
    const p = state.processes[r.processId];
    if (!p || p.cardId !== card.id || r.status === "已重算") continue;
    const old = r.status;
    r.status = "已重算";
    pushLedger(state, {
      rev: ++state.rev,
      kind: "record",
      key: r.id,
      carpetNo: r.carpetNo,
      field: "status",
      oldValue: old,
      newValue: "已重算",
      source: "system",
      note: "复检通过：修复前后记录重算完成",
      at: Date.now(),
    });
  }
}

/** 复核色卡有效期/范围，状态变化立即触发级联 */
export function evaluateCards(state: ServerState): { changed: string[] } {
  const changed: string[] = [];
  const now = Date.now();
  for (const card of Object.values(state.cards)) {
    const expired =
      !!card.validUntil && new Date(card.validUntil).getTime() < startOfDay(now);
    const effective: ColorCard["status"] = expired
      ? "过期"
      : card.status === "范围已调整"
        ? "范围已调整"
        : "有效";
    if (effective === card.status) continue;
    const old = card.status;
    card.status = effective;
    changed.push(card.code);
    pushLedger(state, {
      rev: ++state.rev,
      kind: "card",
      key: card.code,
      field: "status",
      oldValue: old,
      newValue: effective,
      source: "system",
      note:
        effective === "有效"
          ? "色卡复检通过，恢复有效"
          : effective === "过期"
            ? "色卡过期：关联工序与修复前后记录立即作废重算"
            : "色卡范围调整：关联工序与修复前后记录立即作废重算",
      at: now,
    });
    if (effective === "有效") restoreForCard(state, card);
    else voidForCard(state, card, effective === "过期" ? "色卡过期" : "色卡范围已调整", effective === "过期" ? "all" : "excluded");
  }
  return { changed };
}

/** 复检：延期并确认范围，通过后恢复 */
export function reinspectCard(
  state: ServerState,
  code: string,
  patch: { validUntil?: string; scope?: string[] },
): void {
  const card = state.cards[code];
  if (!card) return;
  if (patch.validUntil !== undefined) card.validUntil = patch.validUntil;
  if (patch.scope !== undefined) card.scope = patch.scope;
  if (card.status !== "有效") {
    const old = card.status;
    card.status = "有效";
    pushLedger(state, {
      rev: ++state.rev,
      kind: "card",
      key: code,
      field: "status",
      oldValue: old,
      newValue: "有效",
      source: "system",
      note: "色卡复检通过",
      at: Date.now(),
    });
    restoreForCard(state, card);
  }
}

/** 调整适用范围：范围收窄后关联工序立即作废 */
export function adjustScope(state: ServerState, code: string, scope: string[]): void {
  const card = state.cards[code];
  if (!card) return;
  card.scope = scope;
  if (card.status === "有效") {
    const old = card.status;
    card.status = "范围已调整";
    pushLedger(state, {
      rev: ++state.rev,
      kind: "card",
      key: code,
      field: "status",
      oldValue: old,
      newValue: "范围已调整",
      source: "system",
      note: "色卡适用范围调整：关联工序与修复前后记录立即作废重算",
      at: Date.now(),
    });
    voidForCard(state, card, "色卡范围已调整", "excluded");
  }
}

/** 一键重算：为作废工序重新匹配当前有效色卡，记录重算 */
export function recalcAll(state: ServerState): {
  relinked: number;
  stillVoid: number;
  recordsRecalc: number;
} {
  evaluateCards(state);
  let relinked = 0;
  let stillVoid = 0;
  let recordsRecalc = 0;
  for (const p of Object.values(state.processes)) {
    if (p.status !== "作废") continue;
    const candidate = Object.values(state.cards).find(
      (c) =>
        c.status === "有效" &&
        (c.scope.length === 0 || c.scope.includes(p.carpetNo)),
    );
    if (candidate) {
      p.cardId = candidate.id;
      p.status = p.checked ? "已完工" : "进行中";
      p.voidReason = undefined;
      relinked++;
      pushLedger(state, {
        rev: ++state.rev,
        kind: "process",
        key: p.id,
        carpetNo: p.carpetNo,
        field: "cardId",
        oldValue: undefined,
        newValue: candidate.code,
        source: "system",
        note: "作废重算：重新匹配有效色卡",
        at: Date.now(),
      });
    } else {
      stillVoid++;
    }
  }
  for (const r of Object.values(state.records)) {
    if (r.status !== "待重算") continue;
    const p = state.processes[r.processId];
    if (p && p.status !== "作废") {
      r.status = "已重算";
      recordsRecalc++;
      pushLedger(state, {
        rev: ++state.rev,
        kind: "record",
        key: r.id,
        carpetNo: r.carpetNo,
        field: "status",
        oldValue: "待重算",
        newValue: "已重算",
        source: "system",
        note: "作废重算：修复前后记录重算完成",
        at: Date.now(),
      });
    }
  }
  return { relinked, stillVoid, recordsRecalc };
}

/** 解决冲突：两版均已留档，选择其中一版落地 */
export function resolveConflict(
  state: ServerState,
  conflictId: string,
  choice: "local" | "remote",
): void {
  const c = state.conflicts.find((x) => x.id === conflictId);
  if (!c || c.status !== "待确认") return;
  const value = choice === "local" ? c.clientValue : c.serverValue;
  const id = fieldKey(c.kind, c.key, c.field);
  const cur = state.fields[id];
  if (cur) {
    cur.value = value;
    cur.baseRev = c.serverRev;
    cur.rev = ++state.rev;
    cur.writerId = "resolution";
  }
  materialize(state, {
    opId: c.opId,
    clientId: "resolution",
    kind: c.kind,
    key: c.key,
    carpetNo: c.carpetNo,
    field: c.field,
    value,
    baseRev: c.serverRev,
    at: c.at,
  });
  c.status = choice === "local" ? "已采用本地" : "已采用服务端";
  pushLedger(state, {
    rev: ++state.rev,
    kind: c.kind,
    key: c.key,
    carpetNo: c.carpetNo,
    field: c.field,
    oldValue: c.serverValue,
    newValue: value,
    source: "system",
    note: `冲突已解决：采用${choice === "local" ? "本地平板" : "服务端总档"}版（两版均已留档）`,
    at: Date.now(),
  });
}
