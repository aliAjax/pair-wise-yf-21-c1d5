import { seedState } from "./src/seed";
import {
  adjustScope,
  applyOp,
  recalcAll,
  reinspectCard,
  resolveConflict,
} from "./src/engine";
import type { Op } from "./src/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", msg);
  }
}

// 1. 种子：IND-07 过期 → 关联工序作废、记录待重算
const s = seedState();
assert(s.cards["IND-07"].status === "过期", "seed: IND-07 过期");
assert(s.processes["prc-138-1"].status === "作废", "seed: prc-138-1 作废");
assert(s.records["rec-138-1b"].status === "待重算", "seed: rec-138-1b 待重算");
assert(s.records["rec-138-1a"].status === "待重算", "seed: rec-138-1a 待重算");
assert(s.processes["prc-092-1"].status === "已完工", "seed: prc-092-1 不受影响仍完工");

// 2. 两边改同一字段 → 冲突，两版留档
const base = s.rev;
const opA: Op = {
  opId: "op-a1",
  clientId: "A",
  kind: "carpet",
  key: "CAR-092",
  field: "origin",
  value: "波斯（修订）",
  baseRev: base,
  at: 1,
};
const opB: Op = {
  opId: "op-b1",
  clientId: "B",
  kind: "carpet",
  key: "CAR-092",
  field: "origin",
  value: "伊朗波斯",
  baseRev: base,
  at: 2,
};
assert(applyOp(s, opA, "remote").result === "applied", "A 应用");
assert(applyOp(s, opB, "remote").result === "conflict", "B 冲突");
assert(s.carpets["CAR-092"].origin === "波斯（修订）", "总档保留 A 版不被覆盖");
assert(s.conflicts.length === 1 && s.conflicts[0].status === "待确认", "冲突待确认");
assert(
  s.conflicts[0].serverValue === "波斯（修订）" &&
    s.conflicts[0].clientValue === "伊朗波斯",
  "两版均留档",
);

// 3. 同一客户端连续写入不冲突
const revAfterA = s.rev;
const opA2: Op = {
  opId: "op-a2",
  clientId: "A",
  kind: "carpet",
  key: "CAR-092",
  field: "era",
  value: "约1962s",
  baseRev: revAfterA,
  at: 3,
};
assert(applyOp(s, opA2, "remote").result === "applied", "自己第二次写入应用");

// 4. 重复提交同一 opId → 幂等去重
const ledgerBefore = s.ledger.length;
assert(applyOp(s, opA2, "remote").result === "dedup", "重复 opId 去重");
assert(s.ledger.filter((l) => l.dedup).length === 1, "去重留痕");
assert(s.ledger.length === ledgerBefore + 1, "去重不产生业务记录");

// 5. 冲突解决
resolveConflict(s, s.conflicts[0].id, "remote");
assert(s.conflicts[0].status === "已采用服务端", "冲突已解决");
assert(s.carpets["CAR-092"].origin === "波斯（修订）", "采用服务端版");

// 6. 范围调整：仅作废不再被覆盖的关联工序（prc-117-1 用 ANA-03，CAR-117 被移出范围）
const s2 = seedState();
adjustScope(s2, "ANA-03", ["CAR-092"]);
assert(s2.cards["ANA-03"].status === "范围已调整", "ANA-03 范围已调整");
assert(s2.processes["prc-117-1"].status === "作废", "prc-117-1 作废");
assert(s2.records["rec-117-1b"].status === "待重算", "rec-117-1b 待重算");
assert(s2.records["rec-117-1a"].status === "待重算", "rec-117-1a 待重算");
assert(s2.processes["prc-092-1"].status === "已完工", "prc-092-1 仍被覆盖不受影响");

// 7. 复检通过：IND-07 恢复有效，已勾工序仍可完工，记录重算
reinspectCard(s2, "IND-07", { validUntil: "2027-12-31", scope: ["CAR-138"] });
assert(s2.cards["IND-07"].status === "有效", "IND-07 复检有效");
assert(s2.processes["prc-138-1"].status === "已完工", "prc-138-1 已勾工序仍完工");
assert(s2.records["rec-138-1b"].status === "已重算", "rec-138-1b 已重算");

// 8. 重算：为作废工序重新匹配当前有效色卡（PER-12 范围扩到 CAR-117 后重算）
adjustScope(s2, "PER-12", ["CAR-117", "CAR-092"]);
assert(s2.cards["PER-12"].status === "范围已调整", "PER-12 标记范围已调整");
reinspectCard(s2, "PER-12", { scope: ["CAR-117", "CAR-092"] });
assert(s2.cards["PER-12"].status === "有效", "PER-12 复检有效");
recalcAll(s2);
assert(s2.processes["prc-117-1"].cardId === "card-per12", "重算重新匹配有效色卡 PER-12");
assert(s2.processes["prc-117-1"].status === "进行中", "未勾工序恢复进行中");
assert(s2.records["rec-117-1b"].status === "已重算", "重算后记录已重算");

// 8. 断网新建破损区域（"*" 整条写入）回网合并
const s3 = seedState();
const dmg = {
  id: "dmg-new",
  carpetNo: "CAR-092",
  position: "新标记",
  type: "磨损",
  size: "2cm",
  marked: true,
};
applyOp(
  s3,
  {
    opId: "op-new",
    clientId: "C",
    kind: "damage",
    key: "dmg-new",
    carpetNo: "CAR-092",
    field: "*",
    value: dmg,
    baseRev: s3.rev,
    at: 1,
  },
  "remote",
);
assert(!!s3.damages["dmg-new"], "新破损区域建成");
assert(s3.damages["dmg-new"].type === "磨损", "新区域字段落档");

// 9. 色卡过期优先级高于范围标记
const s4 = seedState();
adjustScope(s4, "IND-07", ["CAR-092"]);
assert(s4.cards["IND-07"].status === "过期", "过期优先于范围调整");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
