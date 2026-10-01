// 种子总档：3 条地毯档案 + 色卡/破损区域/工序/修复前后记录
import type { ServerState } from "./types";
import { evaluateCards } from "./engine";

export function seedState(): ServerState {
  const s: ServerState = {
    rev: 0,
    carpets: {},
    damages: {},
    cards: {},
    processes: {},
    records: {},
    fields: {},
    conflicts: [],
    ledger: [],
    appliedOpIds: {},
  };
  const now = Date.now();

  const put = (
    kind: "carpet" | "damage" | "card" | "process" | "record",
    key: string,
    field: string,
    value: unknown,
  ) => {
    s.fields[`${kind}:${key}:${field}`] = {
      value,
      rev: ++s.rev,
      baseRev: 0,
      writerId: "seed",
    };
    s.ledger.push({
      id: `lg-${s.rev}`,
      rev: s.rev,
      kind,
      key,
      field,
      label: field === "*" ? "档案" : field,
      newValue: value,
      source: "system",
      at: now,
    });
  };

  const carpets = [
    {
      no: "CAR-092",
      origin: "波斯",
      era: "羊毛，约1960s",
      knotDensity: "46 结/平方厘米",
      material: "羊毛",
      dyeType: "植物染",
    },
    {
      no: "CAR-117",
      origin: "安纳托利亚",
      era: "约1950s",
      knotDensity: "42 结/平方厘米",
      material: "羊毛",
      dyeType: "植物染",
    },
    {
      no: "CAR-138",
      origin: "藏毯",
      era: "约1980s",
      knotDensity: "40 结/平方厘米",
      material: "羊毛",
      dyeType: "化学染",
    },
  ];
  for (const c of carpets) {
    s.carpets[c.no] = c;
    put("carpet", c.no, "*", c);
  }

  const cards = [
    {
      id: "card-ind07",
      code: "IND-07",
      name: "靛蓝",
      hex: "#1e3a8a",
      scope: ["CAR-138"],
      validUntil: "2026-06-30", // 已过期 → 关联工序/记录立即作废重算
      status: "有效" as const,
    },
    {
      id: "card-per12",
      code: "PER-12",
      name: "波斯红",
      hex: "#7c2d12",
      scope: ["CAR-092"],
      validUntil: "2027-12-31",
      status: "有效" as const,
    },
    {
      id: "card-ana03",
      code: "ANA-03",
      name: "安纳托利亚黄",
      hex: "#b45309",
      scope: ["CAR-117", "CAR-092"],
      validUntil: "2027-06-30",
      status: "有效" as const,
    },
  ];
  for (const c of cards) {
    s.cards[c.code] = c;
    put("card", c.code, "*", c);
  }

  const damages = [
    {
      id: "dmg-092-1",
      carpetNo: "CAR-092",
      position: "边缘",
      type: "磨损",
      size: "约12cm",
      marked: true,
    },
    {
      id: "dmg-117-1",
      carpetNo: "CAR-117",
      position: "中心",
      type: "缺口",
      size: "约3cm",
      marked: true,
    },
    {
      id: "dmg-138-1",
      carpetNo: "CAR-138",
      position: "毯面",
      type: "褪色",
      size: "局部",
      marked: false,
    },
  ];
  for (const d of damages) {
    s.damages[d.id] = d;
    put("damage", d.id, "*", d);
  }

  const processes = [
    {
      id: "prc-092-1",
      carpetNo: "CAR-092",
      name: "补边加固",
      cardId: "card-per12",
      checked: true,
      status: "已完工" as const,
    },
    {
      id: "prc-117-1",
      carpetNo: "CAR-117",
      name: "中心纹样补线",
      cardId: "card-ana03",
      checked: false,
      status: "进行中" as const,
    },
    {
      id: "prc-138-1",
      carpetNo: "CAR-138",
      name: "靛蓝补线",
      cardId: "card-ind07",
      checked: true,
      status: "待处理" as const,
    },
  ];
  for (const p of processes) {
    s.processes[p.id] = p;
    put("process", p.id, "*", p);
  }

  const mkRec = (
    id: string,
    processId: string,
    carpetNo: string,
    kind: "修复前" | "修复后",
    note: string,
  ) => {
    const r = { id, processId, carpetNo, kind, note, status: "有效" as const };
    s.records[id] = r;
    put("record", id, "*", r);
  };
  mkRec("rec-092-1b", "prc-092-1", "CAR-092", "修复前", "边缘磨损约12cm，纹样残缺");
  mkRec("rec-092-1a", "prc-092-1", "CAR-092", "修复后", "补线完成，色卡PER-12匹配");
  mkRec("rec-117-1b", "prc-117-1", "CAR-117", "修复前", "中心纹样缺口约3cm");
  mkRec("rec-117-1a", "prc-117-1", "CAR-117", "修复后", "待补线完成后记录");
  mkRec("rec-138-1b", "prc-138-1", "CAR-138", "修复前", "局部褪色，需匹配靛蓝色卡");
  mkRec("rec-138-1a", "prc-138-1", "CAR-138", "修复后", "待色卡复检后补线");

  // 首检：IND-07 已过期 → 关联工序/记录立即作废重算
  evaluateCards(s);
  return s;
}
