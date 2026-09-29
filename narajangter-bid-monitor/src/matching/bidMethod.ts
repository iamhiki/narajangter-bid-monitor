/**
 * 낙찰방법 판별 (② 규칙 추출의 일부).
 *
 * 실제 관찰된 낙찰방법 원문 표기가 "협상에 의한 계약"/"협상에 의한 낙찰제"/
 * "협상에 의한 낙찰자 결정"처럼 뒤에 붙는 단어가 제각각이라(PoC4, 2026-09-16 8건 실측),
 * 공백을 지운 뒤 "협상에의한"을 포함하는지만 본다 — 뒤에 어떤 단어가 오든 다 잡힌다.
 *
 * NormalizedNotice.bidMethod는 `sucsfbidMthdNm` 필드로 채워진다는 것을 본공고 실제
 * 응답으로 확인했다(2026-09-16, src/api/fieldCandidates.ts 참고 — 예:
 * "적격심사제-관리규정외 수기심사(총점입력)", "소액수의견적-소액수의견적(2인 이상 견적 제출)").
 * 사전규격은 이 단계에서 낙찰방법이 정해지지 않아 값이 없는 게 정상이라 항상 null이며,
 * 이 함수는 null을 "협상에의한계약 아님(또는 판단 불가)"으로 처리한다(fail-open).
 */
export function isNegotiatedContract(bidMethod: string | null): boolean {
  if (!bidMethod) return false;
  return bidMethod.replace(/\s+/g, "").includes("협상에의한");
}

/**
 * 낙찰방법 분류. 2026-09-29 미팅에서 수집 범위를 이 네 갈래로 나눠 정했다.
 *
 *   협상         — 협상에 의한 계약 (제안서 평가)
 *   규격가격동시 — 규격·가격 동시입찰 (제안적격자 중 최저가 등)
 *   입찰         — 그 밖의 경쟁입찰 (적격심사, 최저가, 2단계 등). 마감이 짧은 경우가 많아
 *                  매일 마감 임박 보고 대상이다 (RUN_MODE=daily).
 *   수의         — 수의시담·소액수의견적 등 수의계약. 수집 대상에서 뺀다.
 */
export const BID_METHOD_CATEGORIES = ["협상", "규격가격동시", "입찰", "수의"] as const;
export type BidMethodCategory = (typeof BID_METHOD_CATEGORIES)[number];

/**
 * 낙찰방법 원문을 분류한다. 값이 없으면 null (판단 불가 — 거르지 않는다).
 *
 * 수의를 가장 먼저 본다. 실측 표기가 "수의시담-수의시담", "소액수의견적-…"처럼 앞머리에
 * 수의가 붙어 오고, 수의계약이면 다른 말이 섞여 있어도 경쟁입찰이 아니기 때문이다.
 * 규격가격동시는 "규격가격동시입찰-제안적격자 중 예가 내 최저가 투찰자"(2026-09-29 실측)처럼
 * 오는데 "규격·가격 동시"로 쓰는 경우도 대비해 가운뎃점·공백을 지우고 본다.
 */
export function classifyBidMethod(bidMethod: string | null): BidMethodCategory | null {
  if (!bidMethod || !bidMethod.trim()) return null;
  const s = bidMethod.replace(/[\s·ㆍ.,]/g, "");
  if (s.includes("수의")) return "수의";
  if (s.includes("협상에의한")) return "협상";
  if (s.includes("규격가격동시")) return "규격가격동시";
  return "입찰";
}
