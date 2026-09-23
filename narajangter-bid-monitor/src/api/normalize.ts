import { createHash } from "node:crypto";
import type { FieldCandidates } from "./fieldCandidates.js";
import { pickNumber, pickString, warnMissingFieldOnce, type RawItem } from "./fieldResolver.js";
import type { BusinessType, NormalizedNotice, SourceType } from "./types.js";

function fallbackNoticeNo(raw: RawItem, title: string, institution: string | null): string {
  const seed = JSON.stringify({ title, institution, keys: Object.keys(raw).sort() });
  return `GEN-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
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
    budgetAmount: pickNumber(raw, fields.budgetAmount),
    detailUrl: pickString(raw, fields.detailUrl),
    industryText: pickString(raw, fields.industryText),
    productClsfcNo: pickString(raw, fields.productClsfcNo),
    productClsfcName: pickString(raw, fields.productClsfcName),
    // 후보 필드명이 실측 검증 전이라 "MthdNm" 접미사 휴리스틱도 함께 시도한다 (fieldResolver.ts 참고).
    bidMethod: pickString(raw, fields.bidMethod, "MthdNm"),
    raw,
  };
}
