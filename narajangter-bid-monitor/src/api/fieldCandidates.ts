/**
 * data.go.kr 나라장터 API의 실제 응답 필드명은 서비스 버전에 따라 조금씩 달라질 수 있어
 * (예: BidPublicInfoService -> BidPublicInfoService04 개정 이력) 필드명 후보를 리스트로 관리하고
 * 첫 번째로 값이 채워져 있는 후보를 사용한다. 실제 운영 중 필드가 비어 보이면
 * `npm run verify:api` 로 원본 응답을 확인한 뒤 이 파일의 후보 목록에 실제 필드명을 추가하면 된다.
 */
export interface FieldCandidates {
  noticeNo: string[];
  title: string[];
  institution: string[];
  postedAt: string[];
  deadline: string[];
  budgetAmount: string[];
  detailUrl: string[];
  /** 투찰가능업종명 등 업종코드 매칭에 사용할 텍스트 필드 (용역/공사) */
  industryText: string[];
  /** 세부품명번호 (물품) */
  productClsfcNo: string[];
  productClsfcName: string[];
  /**
   * 낙찰방법명(예: "적격심사제-...", "소액수의견적-...", "협상에 의한 계약"). `sucsfbidMthdNm`이
   * 본공고(물품/용역/공사) 3종 전부에서 `npm run verify:api`로 실측 확인됨(2026-09-16,
   * 예: "소액수의견적-소액수의견적(2인 이상 견적 제출)", "적격심사제-관리규정외 수기심사(총점입력)").
   * 나머지 후보는 실제 필드명이 바뀌는 경우를 대비한 보조 후보(미검증).
   */
  bidMethod: string[];
}

export const BID_NOTICE_FIELD_CANDIDATES: FieldCandidates = {
  noticeNo: ["bidNtceNo"],
  title: ["bidNtceNm"],
  institution: ["ntceInsttNm", "dmndInsttNm"],
  postedAt: ["bidNtceDate", "bidNtceBgnDt", "bidNtceBgn", "rgstDt"],
  deadline: ["bidClseDate", "bidClseDt", "opengDate", "opengDt"],
  budgetAmount: ["asignBdgtAmt", "presmptPrce", "bssamt", "bssAmt"],
  detailUrl: ["bidNtceDtlUrl", "bidNtceUrl"],
  // 실측(2026-09-22): 세부품명번호의 실제 필드명은 `dtilPrdctClsfcNo`다.
  // 기존 후보 `prdctClsfcNo`는 응답에 존재하지 않아 **7,376건 전부 null**이었고,
  // 그 결과 코드 매칭이 한 건도 일어나지 않아 "강력추천"(코드 AND 키워드) 등급이
  // 구조적으로 0건이었다. purchsObjPrdctList는 `[1^3911160501^LED경관조명기구]` 형태로
  // 복수 품목을 담는 보조 후보다.
  productClsfcNo: ["dtilPrdctClsfcNo", "prdctClsfcNo"],
  productClsfcName: ["dtilPrdctClsfcNoNm", "prdctClsfcNoNm"],
  // `indstrytyLmtYn`은 업종제한 **여부**(Y/N)이지 업종명이 아니다. 후보에 남겨두면
  // 업종명 필드가 없을 때 "Y"/"N"으로 폴백해서, 업종코드 매칭이 무의미한 문자열을
  // 대상으로 돌아간다(실측: 7,376건 중 4,648건이 "Y"/"N"이었다). 그래서 뺐다.
  industryText: ["bidprcPsblIndstrytyNm", "indstrytyNm", "pubPrcrmntClsfcNm"],
  // sucsfbidMthdNm 실측 확인됨(2026-09-16, 본공고 물품/용역/공사 3종 전부).
  bidMethod: ["sucsfbidMthdNm", "bidwinrDcsnMthdNm", "cntrctCnclsMthdNm", "cntrctMthdNm", "bidMethdNm"],
};

/** getBidPblancListInfoLicenseLimit (면허제한정보조회) 응답 필드 후보 */
export interface LicenseLimitFieldCandidates {
  noticeNo: string[];
  groupNo: string[];
  seqNo: string[];
  licenseLimitName: string[];
  allowedIndustryList: string[];
}

export const LICENSE_LIMIT_FIELD_CANDIDATES: LicenseLimitFieldCandidates = {
  noticeNo: ["bidNtceNo"],
  // lmtGrpNo가 npm run verify:api 실제 응답으로 확인된 필드명 (2026-07-28)
  groupNo: ["lmtGrpNo", "rstrctGroupNo", "prtcptLmtGroupNo", "lmtGroupNo", "rstrctGrupNo"],
  seqNo: ["rstrctSeqNo", "lmtSeqNo"],
  licenseLimitName: ["lcnsLmtNm", "licenseLmtNm", "lmtLicenseNm", "prtcptLcnsLmtNm"],
  // permsnIndstrytyList가 npm run verify:api 실제 응답으로 확인된 필드명 (2026-07-28)
  allowedIndustryList: ["permsnIndstrytyList", "alwIndstrytyNm", "admisIndstrytyNm", "prmisnIndstrytyNm", "aloneIndstrytyNm"],
};

export const PRE_STANDARD_FIELD_CANDIDATES: FieldCandidates = {
  noticeNo: ["bfSpecRgstNo", "sptDscrptRegNo"],
  title: ["prdctClsfcNoNm", "bfSpecTaskNm", "bfSpecRgstNm", "reNm", "prdctNm"],
  institution: ["orderInsttNm", "ntceInsttNm", "dmndInsttNm"],
  postedAt: ["bfSpecRgstDate", "bfSpecRgstDt", "rgstDt"],
  deadline: ["opninRgstClseDt", "opninRgstClseDate", "bfSpecClseDt"],
  budgetAmount: ["asignBdgtAmt", "presmptPrce"],
  detailUrl: ["bfSpecDocFileUrl1", "specDocFileUrl1", "bfSpecRgstUrl"],
  // 본공고와 같은 이유로 `dtilPrdctClsfcNo`를 먼저 본다 (위 주석 참고).
  industryText: ["bidprcPsblIndstrytyNm", "indstrytyNm", "pubPrcrmntClsfcNm"],
  productClsfcNo: ["dtilPrdctClsfcNo", "prdctClsfcNo"],
  productClsfcName: ["dtilPrdctClsfcNoNm", "prdctClsfcNoNm"],
  // 사전규격 3종(물품/용역/공사) 전부에서 낙찰방법 관련 필드 자체가 없음을 실측 확인함
  // (2026-09-16, 본공고와 달리 아직 낙찰방법이 확정되지 않는 단계라 당연한 결과 — 버그 아님).
  // 그래도 후보는 남겨둔다(향후 API 개정으로 필드가 추가될 가능성 대비).
  bidMethod: ["sucsfbidMthdNm", "bidwinrDcsnMthdNm", "cntrctCnclsMthdNm", "cntrctMthdNm", "bidMethdNm"],
};
