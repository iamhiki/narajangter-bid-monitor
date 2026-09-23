import type { SimilarityBasis } from "../similarity/index.js";
import type { NormalizedNotice } from "../api/types.js";
import type { CodeEntry } from "../config/loadJsonConfig.js";

export type Confidence = "강력추천" | "참고용";

export interface MatchedNotice {
  notice: NormalizedNotice;
  matchedProductCodes: CodeEntry[];
  matchedIndustryCodes: CodeEntry[];
  matchedKeywords: string[];
  confidence: Confidence;
  /**
   * 해외 개최(전시회/박람회/엑스포 + 한국관/단체관) 몽골 예외 플래그.
   * 몽골이 아닌 해외 개최는 evaluateNotice()에서 이미 자동배제되어 여기까지 오지 않으므로,
   * 이 필드가 채워져 있다는 것 자체가 "몽골 관련 해외 개최라 자동배제하지 않고 표시만 함"을 뜻한다.
   */
  overseasVenueFlag: { matchedMongoliaKeyword: string } | null;
  /**
   * ④ 싱크로율 — 과거 수행사업과 얼마나 겹치는지 (0~1).
   *
   * 선택 필드다. 코퍼스(data/past-projects.json)가 없는 환경(GitHub Actions 등)에서는
   * 채워지지 않고, 그래도 리포트는 그대로 나간다 — 싱크로율은 부가 정보이지 공고를
   * 걸러내는 기준이 아니다. 지금은 **표시만** 하고 필터로 쓰지 않는다. 임계값을 정할
   * 근거(담당자 O/X 판정)가 아직 없기 때문이다.
   */
  similarity?: SimilarityInfo;
  /**
   * 공동수급(공동이행/분담이행) 허용 여부 — g2b.go.kr 비공식 상세 API로 조회한 원문
   * (예: "(없음)공동수급불허", "(전자)분담이행"). src/api/jointBidApi.ts 참고.
   *
   * **표시 전용이다.** 이 값으로 공고를 거르거나 등급을 바꾸지 않는다 — 공동수급 가능
   * 여부를 보고 참여 여부를 정하는 건 회사의 사업 판단이라 시스템이 대신 결정하지 않는다.
   *
   * 선택 필드다. 조회를 켜지 않았거나(본공고만 켤 수 있음), 비공식 API 호출이 실패했거나,
   * 사전규격이라 아예 대상이 아니면 채워지지 않는다 — 그때는 "확인 안 됨"으로 다뤄야지
   * "공동수급불허"로 오해하면 안 된다.
   */
  jointBidStatus?: string;
}

export interface SimilarityInfo {
  /**
   * 원점수 (코사인·포화 포함도 그대로, 0~1).
   *
   * 보정된 값만 남기면 나중에 곡선을 고쳤을 때 과거 기록을 다시 계산할 수 없다.
   * 계산·재보정의 기준이므로 반드시 함께 보존한다.
   */
  score: number;
  /**
   * 사람이 읽는 싱크로율 (0~1). `score`를 기준별 보정 곡선에 통과시킨 값이다.
   *
   * 보정은 **단조 변환**이라 순위는 `score`와 완전히 같다 — 눈금만 바꾼다.
   * 자세한 근거는 similarity/calibrate.ts 참고.
   */
  shown: number;
  /**
   * 점수의 근거 — 공고 제목만 봤는지, 첨부 과업지시서까지 읽었는지.
   *
   * **두 기준의 점수는 직접 비교하면 안 된다.** 질의에 담긴 정보량이 달라 분포가 다르다.
   * 임계값도 기준별로 따로 잡아야 해서 시트에 같이 남긴다.
   */
  basis: SimilarityBasis;
  /** 과업 내용을 뽑아온 첨부파일명 (첨부를 읽은 경우에만) */
  sourceFile?: string;
  /** 상위 유사 과거사업 (기여도 순) */
  top: { id: string; name: string; year: number; score: number }[];
}
