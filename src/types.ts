// 续作修订账 —— 领域模型定义

/** 可离线补录的字段：地毯主档字段 + 破损区域描述（damage:<damageId>） */
export type FieldKey =
  | "origin"
  | "period"
  | "knotDensity"
  | "material"
  | "dyeType"
  | "condition"
  | `damage:${string}`;

export interface DamageArea {
  id: string;
  label: string;
  /** 纹样局部标记图上的位置（百分比坐标） */
  x: number;
  y: number;
  note: string;
}

export type CardStatus = "active" | "expired";

export interface ColorCard {
  id: string;
  colorName: string;
  colorHex: string;
  /** 补线材质 */
  material: string;
  /** 染色来源 */
  dyeSource: string;
  /** 适用范围（哪些纹样/区域可以用这张色卡） */
  range: string;
  validUntil: string; // YYYY-MM-DD
  status: CardStatus;
  version: number;
  updatedAt: number;
  updatedReason?: string;
}

export type ProcedureStatus = "pending" | "in_progress" | "done" | "voided";

export interface Procedure {
  id: string;
  carpetId: string;
  damageId: string;
  name: string;
  cardId: string;
  status: ProcedureStatus;
  startedAt?: number;
  completedAt?: number;
  voidedAt?: number;
  voidReason?: string;
  /** 作废重算后生成的后继工序 */
  successorId?: string;
  predecessorId?: string;
}

export type RecordPhase = "before" | "after";

export interface RepairRecord {
  id: string;
  procedureId: string;
  carpetId: string;
  phase: RecordPhase;
  content: string;
  createdAt: number;
  voidedAt?: number;
  voidReason?: string;
}

export interface Carpet {
  id: string;
  /** 地毯编号，合并主键 */
  carpetNo: string;
  origin: string;
  period: string;
  knotDensity: string;
  material: string;
  dyeType: string;
  condition: string;
  updatedAt: number;
  damages: DamageArea[];
}

export type RevisionStatus = "merged" | "conflict" | "resolved";

/** 修订账：一条字段级并回记录 */
export interface FieldRevision {
  id: string;
  carpetId: string;
  carpetNo: string;
  field: FieldKey;
  fieldLabel: string;
  /** 离线编辑所基于的总档原值 */
  baseValue: string;
  /** 平板（离线）版本 */
  clientValue: string;
  /** 总档版本（两边都改过时有值） */
  serverValue?: string;
  status: RevisionStatus;
  winner?: "client" | "server";
  reason: string;
  /** 幂等键：同一笔离线补录反复提交只出一条修订 */
  opId: string;
  updatedAt: number;
  resolvedAt?: number;
}

export type LogLevel = "info" | "success" | "warn" | "danger";

export interface LogEntry {
  id: string;
  time: number;
  level: LogLevel;
  message: string;
}

// ---------- 离线操作（待传队列里的最小单元） ----------

export type OpType =
  | "fieldEdit"
  | "cardExpire"
  | "cardRange"
  | "cardRecertify"
  | "reassignCard"
  | "startProcedure"
  | "completeProcedure"
  | "resolveConflict";

export type OpPayload =
  | { carpetId: string; field: FieldKey; baseValue: string; newValue: string }
  | { cardId: string; reason: string }
  | { cardId: string; newRange: string; reason: string }
  | { cardId: string; newValidUntil: string; reason: string }
  | { procedureId: string; cardId: string }
  | { procedureId: string }
  | { procedureId: string; afterNote: string }
  | { revisionId: string; winner: "client" | "server" };

export interface ClientOp {
  opId: string;
  type: OpType;
  time: number;
  payload: OpPayload;
}

export type OutboxStatus = "pending" | "done" | "failed" | "rejected";

export interface OutboxItem extends ClientOp {
  status: OutboxStatus;
  attempts: number;
  lastAttemptAt?: number;
  error?: string;
}

export type OpResult =
  | {
      ok: true;
      conflict?: boolean;
      revisionId?: string;
      duplicate?: boolean;
      cascade?: { voidedProcs: number; newProcs: number; voidedRecords: number };
    }
  | { ok: false; code: "VALIDATION"; message: string; revisionId?: string };

/** 纯数据快照，服务端总档与平板工作副本共用同一结构 */
export interface Snapshot {
  carpets: Carpet[];
  cards: ColorCard[];
  procedures: Procedure[];
  records: RepairRecord[];
}
