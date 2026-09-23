/**
 * 과거 수행/검토 사업 1건. 유사도 스코어링(④단계)의 비교 대상이다.
 *
 * 핵심 설계: **제안서 PDF가 없어도 1건이 성립한다.** 폴더명만 있으면 `name`이 채워지고
 * 그것만으로 코사인 비교가 된다. 과업지시서가 있으면 `body`/`officialName`/`budgetAmount`가
 * 추가로 채워져 정밀도가 올라갈 뿐이다. 이렇게 두지 않으면 "자료가 다 모일 때까지"
 * ④단계를 시작할 수 없게 되는데, 실제로 103개 폴더 중 30개는 과업지시서가 유실된 상태다.
 */
export interface PastProject {
  /** 폴더 경로 기반 고유 ID (예: "2026/2026_충주씨네") */
  id: string;
  /** 공고/수행 연도. 폴더 구조(<연도>/<사업>)에서 얻는다. */
  year: number;
  /** 원본 폴더명 (추적용 — 담당자가 서버에서 바로 찾을 수 있어야 한다) */
  folderName: string;
  /** 사업명. 과업지시서에서 뽑은 정식명이 있으면 그것, 없으면 폴더명 정제본. */
  name: string;
  /** 과업지시서 본문에서 추출한 정식 사업명 (없으면 null) */
  officialName: string | null;
  /** 과업지시서/제안요청서 본문 (추출 실패 시 빈 문자열) */
  body: string;
  /** 본문에서 추출한 총사업비(원). 못 찾으면 null. */
  budgetAmount: number | null;
  /** 본문을 뽑아온 파일들 (상대경로) */
  sourceFiles: string[];
}

/** 추출기 하나의 결과. 실패해도 예외를 던지지 않고 reason을 남긴다. */
export interface ExtractResult {
  text: string;
  /** 추출 실패/부분성공 사유. 성공이면 null. */
  reason: string | null;
}
