export type BusinessType = "물품" | "용역" | "공사";
export type SourceType = "본공고" | "사전규격";

export interface NormalizedNotice {
  /** 공고번호(본공고) 또는 사전규격등록번호(사전규격). 없으면 제목+기관 조합으로 대체 생성됨 */
  noticeNo: string;
  title: string;
  institution: string | null;
  businessType: BusinessType;
  sourceType: SourceType;
  postedAt: string | null;
  deadline: string | null;
  budgetAmount: number | null;
  detailUrl: string | null;
  /** 업종코드 매칭에 사용되는 원문 텍스트 (투찰가능업종명 등) */
  industryText: string | null;
  productClsfcNo: string | null;
  productClsfcName: string | null;
  /**
   * 낙찰방법명 원문(예: "적격심사제-...", "소액수의견적-...", "협상에 의한 계약").
   * `sucsfbidMthdNm` 필드로 온다는 것을 본공고 3종에서 실측 확인함(2026-09-16,
   * src/api/fieldCandidates.ts 참고). 사전규격은 이 단계에서 낙찰방법이 아직 정해지지
   * 않아 값이 없는 게 정상이라 항상 null이다. 후보가 빗나가는 경우를 포함해 null이면
   * matching/bidMethod.ts는 fail-open(판단 불가 시 걸러내지 않음)으로 동작한다.
   */
  bidMethod: string | null;
  /** 필드 매핑 실패 시 디버깅용으로 원본 보존 */
  raw: Record<string, unknown>;
}

export interface FetchWindow {
  /** 조회 시작 (YYYYMMDDHHMM) */
  begin: Date;
  /** 조회 종료 (YYYYMMDDHHMM) */
  end: Date;
}

export interface FetchResult {
  businessType: BusinessType;
  notices: NormalizedNotice[];
  /** 이 업무구분 조회가 실패했는지 여부 (부분 실패를 리포트에 표기하기 위함) */
  failed: boolean;
  errorMessage?: string;
}
