import { describe, expect, it } from "vitest";
import { decisionsCsv } from "../src/state/decisionCsv.js";

describe("decisionsCsv — 구글 드라이브 백업의 판단기록.csv", () => {
  const records = {
    A: {
      noticeNo: "R26BK00000001",
      title: "OO과학관 전시물 제작설치",
      status: "참가",
      owner: "김담당",
      tags: ["본업과 맞음", "유사 실적 있음"],
      reason: "작년 OO과학관과 비슷함",
      decidedBy: "김담당",
      decidedAt: "2026-10-19T01:30:00.000Z",
      meta: { sourceType: "본공고", institution: "OO시", budgetAmount: 300000000, keywords: ["과학관"], products: [], score: 72, detailUrl: "https://x" },
    },
    B: {
      noticeNo: "R26BK00000002",
      title: '쉼표, "따옴표" 든 공고',
      status: "불참",
      owner: "이담당",
      tags: ["금액 적음"],
      reason: "여러 줄\n사유",
      decidedBy: "이담당",
      decidedAt: "2026-10-19T05:00:00.000Z",
    },
    C: { noticeNo: "R26BK00000003", title: "판단 해제한 공고", status: null, owner: "" },
    D: { noticeNo: "R26BK00000004", title: "검토중 공고", status: "검토중", owner: "박담당" },
  };

  it("엑셀·시트에서 한글이 깨지지 않게 BOM으로 시작하고, 화면 CSV와 같은 머리글이다", () => {
    const csv = decisionsCsv(records);
    expect(csv.startsWith("﻿판단일시,판단,주된 사유,사유,판단자,담당,공고번호,공고명")).toBe(true);
  });

  it("참가·보류·불참만 최근 판단 순으로 싣고, 판단 시각은 한국 시각이다", () => {
    const lines = decisionsCsv(records).split("\r\n");
    expect(lines).toHaveLength(3); // 머리글 + 2건 (판단 해제·검토중은 뺀다)
    expect(lines[1]!.startsWith("2026-10-19 14:00,불참,")).toBe(true);
    expect(lines[2]!.startsWith("2026-10-19 10:30,참가,\"본업과 맞음, 유사 실적 있음\",작년 OO과학관과 비슷함,김담당,김담당,R26BK00000001")).toBe(true);
    expect(lines[2]).toContain(",본공고,,OO시,300000000,,,과학관,,72,,https://x");
  });

  it("쉼표·따옴표·줄바꿈이 든 칸은 따옴표로 감싼다", () => {
    const csv = decisionsCsv(records);
    expect(csv).toContain('"쉼표, ""따옴표"" 든 공고"');
    expect(csv).toContain('"여러 줄\n사유"');
  });

  it("판단이 하나도 없으면 머리글만 있다", () => {
    expect(decisionsCsv({}).split("\r\n")).toHaveLength(1);
  });
});
