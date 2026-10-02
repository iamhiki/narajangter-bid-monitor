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

/** 나라장터 업무구분 코드 — 사전규격 상세 화면 주소에 쓴다 */
const PRCM_BSNE_SE_CD: Record<string, string> = { 물품: "01", 공사: "02", 용역: "03" };

/**
 * 사전규격 상세 화면 주소. 사전규격 API에는 상세 화면 주소가 없고 첨부(규격서) 다운로드 주소
 * (specDocFileUrl1 = …/UntyAtchFile/downloadFile.do)만 있어서, 그걸 링크로 쓰면 누를 때 파일이 받아졌다
 * (2026-10-02 국립디자인박물관 콘텐츠 수집 사전규격). 본공고의 PNPE027_01처럼 나라장터 화면 링크를 만든다.
 * 형식은 다른 나라장터 수집 프로젝트(minsung6333/nara-monitor)에서 쓰는 것과 같다.
 */
export function preStandardDetailUrl(noticeNo: string, businessType: string): string {
  const code = PRCM_BSNE_SE_CD[businessType] ?? "03";
  return `https://www.g2b.go.kr/link/PRVA004_02/single/?bfSpecRegNo=${encodeURIComponent(noticeNo)}&prcmBsneSeCd=${code}`;
}

export function normalizeRawItem(
  raw: RawItem,
  businessType: BusinessType,
  sourceType: SourceType,
  fields: FieldCandidates
): NormalizedNotice {
  const context = `${sourceType}/${businessType}`;

  // 접미사 추측("…Nm" 아무 필드)은 쓰지 않는다 — 제목이 비면 기관명(ntceInsttNm) 같은 엉뚱한 값이 제목이 된다.
  // 2026-10-02 본공고 6.8만·사전규격 2.2천 건 점검에서 추측이 쓰인 적은 없었다. 비면 아래에서 "제목 확인 필요"로 표시한다.
  const title = pickString(raw, fields.title);
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
    detailUrl: sourceType === "사전규격" && noticeNoRaw ? preStandardDetailUrl(noticeNoRaw, businessType) : pickString(raw, fields.detailUrl),
    industryText: pickString(raw, fields.industryText),
    productClsfcNo: pickString(raw, fields.productClsfcNo),
    productClsfcName: pickString(raw, fields.productClsfcName),
    // 접미사 추측("…MthdNm")은 쓰지 않는다 — 낙찰방법이 비면 예가방법(rsrvtnPrceReMkngMthdNm)·평가방법
    // (tpEvalApplMthdNm) 같은 다른 "방법" 필드가 들어가 낙찰방법 필터가 엉뚱하게 판정한다. 비면 null(필터 통과).
    bidMethod: pickString(raw, fields.bidMethod),
    raw,
  };
}
