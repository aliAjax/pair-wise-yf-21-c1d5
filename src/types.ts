// 续作修订账：领域模型

export type Kind = "carpet" | "damage" | "card" | "process" | "record";

export type CardStatus = "有效" | "过期" | "范围已调整";
export type ProcessStatus = "待处理" | "进行中" | "已完工" | "作废";
export type RecordStatus = "有效" | "待重算" | "已重算";

/** 地毯档案（业务键：no 地毯编号） */
export interface Carpet {
  no: string;
  origin: string; // 产地
  era: string; // 年代
  knotDensity: string; // 结密度
  material: string; // 材质
  dyeType: string; // 染色类型
}

/** 破损区域 */
export interface DamageArea {
  id: string;
  carpetNo: string; // 归属地毯编号
  position: string; // 位置（纹样图上的位置）
  type: string; // 破损类型
  size: string; // 尺寸
  marked: boolean; // 是否已在纹样局部标记图上标注
}

/** 材料色卡 */
export interface ColorCard {
  id: string;
  code: string; // 色卡号（业务键）
  name: string; // 颜色名
  hex: string; // 色值
  scope: string[]; // 适用地毯编号范围（空数组 = 全部适用）
  validUntil: string; // 有效期至 YYYY-MM-DD
  status: CardStatus;
}

/** 修复工序 */
export interface RepairProcess {
  id: string;
  carpetNo: string;
  name: string; // 工序名称
  cardId?: string; // 关联材料色卡
  checked: boolean; // 复检是否已勾
  status: ProcessStatus;
  voidReason?: string; // 作废原因
}

/** 修复前后记录 */
export interface BeforeAfterRecord {
  id: string;
  processId: string;
  carpetNo: string;
  kind: "修复前" | "修复后";
  note: string; // 记录内容
  status: RecordStatus;
}

/** 字段级状态：当前值 + 最后写入的修订 + 写入方 */
export interface FieldState {
  value: unknown;
  rev: number; // 服务端修订号（全局递增）
  baseRev: number; // 写入方当时基于哪个修订
  writerId: string; // 写入方（用于识别同一客户端的连续写入）
}

/** 字段冲突：两版都留档，待人工确认 */
export interface Conflict {
  id: string;
  kind: Kind;
  key: string; // 档案键（地毯编号 / 色卡号 / 记录 id）
  carpetNo?: string;
  field: string;
  label: string;
  serverValue: unknown; // 服务端总档版
  clientValue: unknown; // 平板离线版
  serverRev: number;
  clientBaseRev: number;
  status: "待确认" | "已采用本地" | "已采用服务端";
  opId: string;
  at: number;
}

/** 修订账条目 */
export interface LedgerEntry {
  id: string;
  rev: number;
  kind: Kind;
  key: string;
  carpetNo?: string;
  field: string;
  label: string;
  oldValue?: unknown;
  newValue?: unknown;
  source: "local" | "remote" | "system";
  opId?: string;
  note?: string;
  dedup?: boolean; // 幂等去重标记
  at: number;
}

/** 服务端总档 */
export interface ServerState {
  rev: number;
  carpets: Record<string, Carpet>;
  damages: Record<string, DamageArea>;
  cards: Record<string, ColorCard>;
  processes: Record<string, RepairProcess>;
  records: Record<string, BeforeAfterRecord>;
  fields: Record<string, FieldState>;
  conflicts: Conflict[];
  ledger: LedgerEntry[];
  appliedOpIds: Record<
    string,
    { rev: number; result: "applied" | "dedup" | "conflict"; at: number }
  >;
}

/** 离线操作（平板断网期间产生，回网后逐条上传） */
export interface Op {
  opId: string; // 幂等键（客户端生成，重试不变）
  clientId: string; // 写入客户端标识
  kind: Kind;
  key: string; // 档案键
  carpetNo?: string;
  field: string; // 字段路径；"*" 表示整条档案
  value: unknown;
  baseRev: number; // 客户端基于的服务端修订
  at: number;
}
