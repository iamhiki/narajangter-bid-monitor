/**
 * 해외 개최 판별 필터(③-b) 검증용 표본 8건.
 * 출처: 사용자가 제공한 `해외공고_해외테마공고_수집본.xlsx`(시트 `해외현지사업` 4건 +
 * `해외테마사업` 4건, 2026-09-16). 이 파일에 값을 그대로 옮겨 적어 레포 안에서
 * 재현 가능하게 고정했다 — 원본 xlsx는 레포 밖(사용자 로컬 Documents 폴더)에 있어
 * 다른 환경에서는 접근할 수 없기 때문이다.
 *
 * expectedOverseasVenue: 사람이 판단한 정답(해외현지사업 시트=true, 해외테마사업 시트=false).
 * 8건 모두 몽골과 무관하므로 shouldAutoExclude 기대값은 expectedOverseasVenue와 동일하다.
 */
export interface OverseasVenueSample {
  noticeNo: string;
  title: string;
  institution: string;
  expectedOverseasVenue: boolean;
}

export const OVERSEAS_VENUE_SAMPLES: OverseasVenueSample[] = [
  // --- 해외현지사업 (정답=해외 개최, 4건) ---
  {
    noticeNo: "R25BK01088711 - 000",
    title: "2026 독일 프랑크푸르트 소비재 전시회 한국관 설치공사",
    institution: "한국문구공업협동조합",
    expectedOverseasVenue: true,
  },
  {
    noticeNo: "R25BK01250467 - 000",
    title: "｢2026 프랑스 파리 춘계 프레미에르비죵 전시회｣ 한국관 설치공사",
    institution: "사단법인 한국섬유수출입협회",
    expectedOverseasVenue: true,
  },
  {
    noticeNo: "R25BK00775023 - 000",
    title: "2025 일본 도쿄 문구 및 사무용품 전시회 수출컨소시엄 한국관 설치공사",
    institution: "한국문구공업협동조합",
    expectedOverseasVenue: true,
  },
  {
    noticeNo: "R25BK00717096 - 000",
    title: "HIMSS Europe 2025 전시회 한국관 설치 및 운영",
    institution: "조달청 충북지방조달청",
    expectedOverseasVenue: true,
  },
  // --- 해외테마사업 (정답=국내 개최, 4건 — "해외"라는 주제만 다룰 뿐 시공 자체는 국내) ---
  {
    noticeNo: "R26BK01360877-000",
    title: "2026년도 국립인천해양박물관 그리스 바다동화 특별전 제작·설치 용역",
    institution: "국립인천해양박물관",
    expectedOverseasVenue: false,
  },
  {
    noticeNo: "R26BK01609623 - 000",
    title: "전주 아세안홀 전시 공간 시공 용역",
    institution: "한아세안센터",
    expectedOverseasVenue: false,
  },
  {
    noticeNo: "20230309976 - 000",
    title: "2023 특별전 영국 내셔널갤러리명화전(가제) 전시연출 설계 및 제작설치",
    institution: "조달청 서울지방조달청",
    expectedOverseasVenue: false,
  },
  {
    noticeNo: "20170332822 - 000",
    title: "2017년 울산박물관 해외특별전(이집트 보물전)사인물 및 그래픽 제작 설치 용역",
    institution: "울산광역시 울산박물관",
    expectedOverseasVenue: false,
  },
];
