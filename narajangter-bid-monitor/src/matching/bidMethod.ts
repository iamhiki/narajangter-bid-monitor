/**
 * 낙찰방법 판별 (② 규칙 추출의 일부).
 *
 * 실제 관찰된 낙찰방법 원문 표기가 "협상에 의한 계약"/"협상에 의한 낙찰제"/
 * "협상에 의한 낙찰자 결정"처럼 뒤에 붙는 단어가 제각각이라(PoC4, 2026-09-16 8건 실측),
 * 공백을 지운 뒤 "협상에의한"으로 시작하는지만 본다 — 뒤에 어떤 단어가 오든 다 잡힌다.
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
