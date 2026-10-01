import type {
  Carpet,
  ClientOp,
  ColorCard,
  FieldKey,
  FieldRevision,
  OpPayload,
  OpResult,
  Procedure,
  RepairRecord,
  Snapshot,
} from "./types";
import { clone, uid } from "./utils";

// ---------------------------------------------------------------------------
// 纯函数修订引擎（"续作修订账"核心）
//
// 设计要点：
//  1. 字段级三向合并：以 (地毯编号, 字段) 为键，base/client/server 三方比较，
//     后写不再覆盖；两边都改 -> 留两版（conflict），不自动选边。
//  2. 色卡级联作废：色卡过期 / 范围调整，使用该色卡的未完成工序立即作废并
//     生成重算工序；修复前后记录随工序一并作废，且对“已勾选完工”的尝试
//     在 completeProcedure 做硬校验——色卡失效的工序不能完工。
//  3. 幂等：任何操作带 opId；已处理过的 opId 直接返回成功且不产生第二条记录。
// ---------------------------------------------------------------------------

export interface EngineState extends Snapshot {
  revisions: FieldRevision[];
  /** 已处理操作幂等表：opId -> revisionId / 结果标记 */
  appliedOps: Record<string, { conflict: boolean; revisionId?: string }>;
}

export function getFieldValue(carpet: Carpet, field: FieldKey): string {
  if (field.startsWith("damage:")) {
    const damageId = field.slice("damage:".length);
    return carpet.damages.find((d) => d.id === damageId)?.note ?? "";
  }
  return carpet[field as keyof Carpet] as string;
}

export function setFieldValue(carpet: Carpet, field: FieldKey, value: string): void {
  if (field.startsWith("damage:")) {
    const damageId = field.slice("damage:".length);
    const damage = carpet.damages.find((d) => d.id === damageId);
    if (damage) {
      damage.note = value;
    }
    return;
  }
  (carpet as unknown as Record<string, string>)[field] = value;
}

export function fieldLabel(field: FieldKey): string {
  if (field.startsWith("damage:")) {
    return `破损区域 · ${field.slice("damage:".length)}`;
  }
  const map: Record<Exclude<FieldKey, `damage:${string}`>, string> = {
    origin: "地毯产地",
    period: "年代",
    knotDensity: "结密度",
    material: "材质",
    dyeType: "染色类型",
    condition: "保存状态",
  };
  return map[field as Exclude<FieldKey, `damage:${string}`>];
}

export function cardEffective(card: ColorCard, now: number): boolean {
  if (card.status === "expired") return false;
  const expiry = new Date(`${card.validUntil}T23:59:59`).getTime();
  return now <= expiry;
}

/** 工序当前是否还挂在一张有效色卡上（完工的唯一前置条件） */
export function procedureCardValid(
  proc: Procedure,
  cards: ColorCard[],
  now: number
): boolean {
  if (proc.status === "voided") return false;
  const card = cards.find((c) => c.id === proc.cardId);
  return !!card && cardEffective(card, now);
}

export interface CascadeResult {
  voidedProcedures: string[];
  newProcedures: string[];
  voidedRecords: string[];
}

/**
 * 色卡失效（过期 / 复检不合格 / 范围调整）的级联：
 * 关联的未完成工序立即作废并生成同名重算工序；
 * 其修复前/修复后记录随工序作废。
 * 已完工工序不追溯（修复事实保留），但其修复后记录会标注色卡已失效。
 */
function cascadeCardInvalid(
  state: EngineState,
  cardId: string,
  reason: string,
  now: number
): CascadeResult {
  const result: CascadeResult = {
    voidedProcedures: [],
    newProcedures: [],
    voidedRecords: [],
  };

  // 遍历快照：重算工序会被追加进 state.procedures，且暂挂同一张失效色卡，
  // 直接遍历活动数组会把新工序再次作废、无限链式生成后继
  for (const proc of [...state.procedures]) {
    if (proc.cardId !== cardId) continue;
    if (proc.status === "voided" || proc.status === "done") continue;

    proc.status = "voided";
    proc.voidedAt = now;
    proc.voidReason = reason;
    result.voidedProcedures.push(proc.id);

    const successor: Procedure = {
      id: uid("proc"),
      carpetId: proc.carpetId,
      damageId: proc.damageId,
      name: `${proc.name}（色卡重算）`,
      cardId, // 暂挂同一张待更换的色卡，需修复师重新指派有效色卡后才能开工/完工
      status: "pending",
      predecessorId: proc.id,
    };
    proc.successorId = successor.id;
    state.procedures.push(successor);
    result.newProcedures.push(successor.id);

    for (const rec of state.records) {
      if (rec.procedureId === proc.id && rec.voidedAt === undefined) {
        rec.voidedAt = now;
        rec.voidReason = reason;
        result.voidedRecords.push(rec.id);
      }
    }
  }
  return result;
}

/**
 * 应用一条操作到总档。纯函数：不修改入参，返回新状态。
 * 幂等：同一 opId 的重复提交直接回放上次结果，不产生第二份记录。
 */
export function applyOp(
  prev: EngineState,
  op: ClientOp,
  now: number
): { state: EngineState; result: OpResult } {
  const seen = prev.appliedOps[op.opId];
  if (seen) {
    return {
      state: prev,
      result: {
        ok: true,
        conflict: seen.conflict,
        revisionId: seen.revisionId,
        duplicate: true,
      },
    };
  }

  const state: EngineState = {
    ...prev,
    carpets: clone(prev.carpets),
    cards: clone(prev.cards),
    procedures: clone(prev.procedures),
    records: clone(prev.records),
    revisions: [...prev.revisions],
    appliedOps: { ...prev.appliedOps },
  };

  const markApplied = (conflict: boolean, revisionId?: string) => {
    state.appliedOps[op.opId] = { conflict, revisionId };
  };

  switch (op.type) {
    // ---- 字段级三向合并 -------------------------------------------------
    case "fieldEdit": {
      const { carpetId, field, baseValue, newValue } = op.payload as Extract<
    OpPayload,
    { carpetId: string; newValue: string }
  >;
      const carpet = state.carpets.find((c) => c.id === carpetId);
      if (!carpet) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "地毯编号不存在" },
        };
      }
      const serverValue = getFieldValue(carpet, field);

      // 总档未动 或 总档恰好与离线值一致：直接并回
      if (serverValue === baseValue || serverValue === newValue) {
        if (serverValue !== newValue) {
          setFieldValue(carpet, field, newValue);
          carpet.updatedAt = now;
        }
        const revision: FieldRevision = {
          id: uid("rev"),
          carpetId,
          carpetNo: carpet.carpetNo,
          field,
          fieldLabel: fieldLabel(field),
          baseValue,
          clientValue: newValue,
          serverValue: serverValue === baseValue ? undefined : serverValue,
          status: "merged",
          winner: serverValue === newValue ? undefined : "client",
          reason:
            serverValue === newValue
              ? "离线内容与总档一致，直接并回"
              : "总档未改该字段，离线补录直接并回",
          opId: op.opId,
          updatedAt: now,
        };
        state.revisions.unshift(revision);
        markApplied(false, revision.id);
        return { state, result: { ok: true, revisionId: revision.id } };
      }

      // 两边都改过：留两版待确认，总档保持现值不动
      const revision: FieldRevision = {
        id: uid("rev"),
        carpetId,
        carpetNo: carpet.carpetNo,
        field,
        fieldLabel: fieldLabel(field),
        baseValue,
        clientValue: newValue,
        serverValue,
        status: "conflict",
        reason: "离线与总档都修改了同一字段，两版并存待修复师确认",
        opId: op.opId,
        updatedAt: now,
      };
      state.revisions.unshift(revision);
      markApplied(true, revision.id);
      return { state, result: { ok: true, conflict: true, revisionId: revision.id } };
    }

    // ---- 冲突裁决（独立 opId，重复裁决幂等） -----------------------------
    case "resolveConflict": {
      const { revisionId, winner } = op.payload as Extract<OpPayload, { winner: 'client' | 'server' }>;
      const revision = state.revisions.find((r) => r.id === revisionId);
      if (!revision) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "修订记录不存在" },
        };
      }
      if (revision.status !== "conflict") {
        markApplied(false, revision.id);
        return { state, result: { ok: true, revisionId: revision.id, duplicate: true } };
      }
      const carpet = state.carpets.find((c) => c.id === revision.carpetId);
      if (!carpet) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "地毯编号不存在" },
        };
      }
      const chosen = winner === "client" ? revision.clientValue : revision.serverValue ?? "";
      setFieldValue(carpet, revision.field, chosen);
      carpet.updatedAt = now;
      revision.status = "resolved";
      revision.winner = winner;
      revision.resolvedAt = now;
      revision.reason = `已人工确认采用${winner === "client" ? "平板（离线）版" : "总档版"}`;
      markApplied(false, revision.id);
      return { state, result: { ok: true, revisionId: revision.id } };
    }

    // ---- 色卡过期：立即作废重算 -----------------------------------------
    case "cardExpire": {
      const { cardId, reason } = op.payload as Extract<OpPayload, { reason: string; cardId: string }>;
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "色卡不存在" },
        };
      }
      card.status = "expired";
      card.version += 1;
      card.updatedAt = now;
      card.updatedReason = reason;
      const cascade = cascadeCardInvalid(
        state,
        cardId,
        `色卡${card.colorName}过期：${reason}`,
        now
      );
      markApplied(false);
      return {
        state,
        result: {
          ok: true,
          cascade: {
            voidedProcs: cascade.voidedProcedures.length,
            newProcs: cascade.newProcedures.length,
            voidedRecords: cascade.voidedRecords.length,
          },
        },
      };
    }

    // ---- 色卡复检合格，重新启用 -----------------------------------------
    case "cardRecertify": {
      const { cardId, newValidUntil, reason } = op.payload as Extract<
    OpPayload,
    { newValidUntil: string }
  >;
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "色卡不存在" },
        };
      }
      card.status = "active";
      card.validUntil = newValidUntil;
      card.version += 1;
      card.updatedAt = now;
      card.updatedReason = reason;
      // 注意：重算工序不会自动恢复或自动完工，必须重新指派/人工推进
      markApplied(false);
      return { state, result: { ok: true } };
    }

    // ---- 色卡范围调整：越界工序立即作废重算 ------------------------------
    case "cardRange": {
      const { cardId, newRange, reason } = op.payload as Extract<OpPayload, { newRange: string }>;
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "色卡不存在" },
        };
      }
      card.range = newRange;
      card.version += 1;
      card.updatedAt = now;
      card.updatedReason = reason;
      const cascade = cascadeCardInvalid(
        state,
        cardId,
        `色卡${card.colorName}适用范围调整为「${newRange}」：${reason}`,
        now
      );
      markApplied(false);
      return {
        state,
        result: {
          ok: true,
          cascade: {
            voidedProcs: cascade.voidedProcedures.length,
            newProcs: cascade.newProcedures.length,
            voidedRecords: cascade.voidedRecords.length,
          },
        },
      };
    }

    // ---- 重算工序重新指派一张有效色卡 -----------------------------------
    case "reassignCard": {
      const { procedureId, cardId } = op.payload as Extract<
        OpPayload,
        { procedureId: string; cardId: string }
      >;
      const proc = state.procedures.find((p) => p.id === procedureId);
      if (!proc) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序不存在" },
        };
      }
      if (proc.status === "voided") {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序已作废，不能指派" },
        };
      }
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "色卡不存在" },
        };
      }
      if (!cardEffective(card, now)) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "不能指派过期色卡" },
        };
      }
      proc.cardId = cardId;
      proc.status = "pending";
      proc.startedAt = undefined;
      markApplied(false);
      return { state, result: { ok: true } };
    }

    // ---- 工序开工 --------------------------------------------------------
    case "startProcedure": {
      const { procedureId } = op.payload as Extract<OpPayload, { procedureId: string; afterNote?: never }>;
      const proc = state.procedures.find((p) => p.id === procedureId);
      if (!proc) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序不存在" },
        };
      }
      if (proc.status === "voided") {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序已作废，不能开工" },
        };
      }
      if (proc.status === "done") {
        markApplied(false);
        return { state, result: { ok: true, duplicate: true } };
      }
      if (!procedureCardValid(proc, state.cards, now)) {
        return {
          state: prev,
          result: {
            ok: false,
            code: "VALIDATION",
            message: "关联色卡已过期/失效，工序须重算后再开工",
          },
        };
      }
      proc.status = "in_progress";
      proc.startedAt = now;
      markApplied(false);
      return { state, result: { ok: true } };
    }

    // ---- 工序完工：色卡失效的工序一律不允许完工（堵住“复检后仍能完工”） ---
    case "completeProcedure": {
      const { procedureId, afterNote } = op.payload as Extract<OpPayload, { afterNote: string }>;
      const proc = state.procedures.find((p) => p.id === procedureId);
      if (!proc) {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序不存在" },
        };
      }
      if (proc.status === "voided") {
        return {
          state: prev,
          result: { ok: false, code: "VALIDATION", message: "工序已作废，不能完工" },
        };
      }
      if (proc.status === "done") {
        // 重复提交：不生成第二份修复后记录
        markApplied(false);
        return { state, result: { ok: true, duplicate: true } };
      }
      if (!procedureCardValid(proc, state.cards, now)) {
        return {
          state: prev,
          result: {
            ok: false,
            code: "VALIDATION",
            message: "色卡已过期或范围调整，工序已作废重算，不能完工",
          },
        };
      }
      proc.status = "done";
      proc.completedAt = now;

      // 修复前记录（开工时若缺失则补一条占位，由修复师补录）
      const hasBefore = state.records.some(
        (r) => r.procedureId === proc.id && r.phase === "before" && !r.voidedAt
      );
      if (!hasBefore) {
        state.records.push({
          id: uid("rec"),
          procedureId: proc.id,
          carpetId: proc.carpetId,
          phase: "before",
          content: "（修复前记录待补录）",
          createdAt: now,
        });
      }
      state.records.push({
        id: uid("rec"),
        procedureId: proc.id,
        carpetId: proc.carpetId,
        phase: "after",
        content: afterNote,
        createdAt: now,
      });
      markApplied(false);
      return { state, result: { ok: true } };
    }

    default:
      return {
        state: prev,
        result: { ok: false, code: "VALIDATION", message: "未知操作类型" },
      };
  }
}
