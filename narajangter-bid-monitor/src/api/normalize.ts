import { createHash } from "node:crypto";
import type { FieldCandidates } from "./fieldCandidates.js";
import { pickNumber, pickString, warnMissingFieldOnce, type RawItem } from "./fieldResolver.js";
import type { BusinessType, NormalizedNotice, SourceType } from "./types.js";

function fallbackNoticeNo(raw: RawItem, title: string, institution: string | null): string {
  const seed = JSON.stringify({ title, institution, keys: Object.keys(raw).sort() });
  return `GEN-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}

/** 0이나 음수는 금액이 아니라 "미입력"이다 — 그대로 쓰면 최소금액 필터에서 부당하게 걸러진다(7일치 75건). */
function pickPositive(raw: RawItem, candidates: string[]): number | null {
  for (const key of candidates) {
    const v = pickNumber(raw, [key]);
    if (v !== null && v > 0) return v;
  }
  return null;
}

/**
 * 추정가격(부가세 제외). 추정가격 필드가 없으면 부가세 포함 금액을 1.1로 나눠 환산한다.
 * 금액 기준을 추정가격 하나로 통일한다(2026-09-30 담당자 결정) — 예전에는 물품·용역은 배정예산(부가세 포함),
 * 공사는 추정가격(부가세 제외)이 섞여 쓰여 같은 "1억 이상"이 종류마다 다르게 적용됐다.
 */
export function estimatedPrice(raw: RawItem, fields: FieldCandidates): number | null {
  const price = pickPositive(raw, fields.budgetAmount);
  if (price !== null) return price;
  const withVat = pickPositive(raw, fields.budgetVatIncluded);
  return withVat === null ? null : Math.round(withVat / 1.1);
}

export function normalizeRawItem(
  raw: RawItem,
  businessType: BusinessType,
  sourceType: SourceType,
  fields: FieldCandidates
): NormalizedNotice {
  const context = `${sourceType}/${businessType}`;

  const title = pickString(raw, fields.title, "Nm");
  if (!title) {
    warnMissingFieldOnce(context, "title", Object.keys(raw));
  }

  const institution = pickString(raw, fields.institution, "InsttNm");
  const noticeNoRaw = pickString(raw, fields.noticeNo);
  const noticeNo = noticeNoRaw ?? fallbackNoticeNo(raw, title ?? "", institution);
  if (!noticeNoRaw) {
    warnMissingFieldOnce(context, "noticeNo", Object.keys(raw));
  }

  return {
    noticeNo,
    title: title ?? "(제목 확인 필요 - 원본 데이터 참조)",
    institution,
    businessType,
    sourceType,
    postedAt: pickString(raw, fields.postedAt),
    deadline: pickString(raw, fields.deadline),
    budgetAmount: estimatedPrice(raw, fields),
    detailUrl: pickString(raw, fields.detailUrl),
    industryText: pickString(raw, fields.industryText),
    productClsfcNo: pickString(raw, fields.productClsfcNo),
    productClsfcName: pickString(raw, fields.productClsfcName),
    // 후보 필드명이 실측 검증 전이라 "MthdNm" 접미사 휴리스틱도 함께 시도한다 (fieldResolver.ts 참고).
    bidMethod: pickString(raw, fields.bidMethod, "MthdNm"),
    raw,
  };
}
