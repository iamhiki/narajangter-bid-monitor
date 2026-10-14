import type { BusinessType } from "./types.js";

// http:// 로 접속 시 간헐적으로 연결 자체가 실패(fetch failed)하는 것이 실측으로 확인되어(2026-08-03)
// https:// 를 기본값으로 사용한다. data.go.kr은 https도 동일하게 지원한다.
export const DEFAULT_BID_NOTICE_BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
export const DEFAULT_PRE_STANDARD_BASE_URL = "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService";

/** 업무구분별 오퍼레이션명. 물품(Thng)/용역(Servc)/공사(Cnstwk) 3종만 다룬다 (전시업체 특성상 외자/기타는 범위 밖). */
export const BID_NOTICE_OPERATIONS: Record<BusinessType, string> = {
  물품: "getBidPblancListInfoThng",
  용역: "getBidPblancListInfoServc",
  공사: "getBidPblancListInfoCnstwk",
};

export const PRE_STANDARD_OPERATIONS: Record<BusinessType, string> = {
  물품: "getPublicPrcureThngInfoThng",
  용역: "getPublicPrcureThngInfoServc",
  공사: "getPublicPrcureThngInfoCnstwk",
};

/** 면허제한정보조회 - 본공고 API 소속 오퍼레이션 (사전규격에는 대응 오퍼레이션이 없어 본공고에만 적용) */
export const LICENSE_LIMIT_OPERATION = "getBidPblancListInfoLicenseLimit";

/** 참가가능지역정보조회 - 본공고 API 소속. 면허제한정보처럼 조회기간 전체를 내려준다 (2026-10-14 실측) */
export const PARTICIPATION_REGION_OPERATION = "getBidPblancListInfoPrtcptPsblRgn";
