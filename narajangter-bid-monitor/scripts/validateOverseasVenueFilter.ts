/**
 * ③-b 해외 개최 판별 필터 — 초기 모델 검증 스크립트.
 *
 * `해외공고_해외테마공고_스캔_설계안.md`(2026-09-16)이 주장한 표본 8건 재현율/정밀도 100%가
 * 실제 코드(src/matching/overseasVenueFilter.ts)로도 그대로 나오는지 눈으로 확인하기 위한
 * 스크립트다. 표본은 test/fixtures/overseasVenueSamples.ts에 고정되어 있다(원본 xlsx는
 * 레포 밖에 있어 재현 불가능하므로 값을 옮겨 적어 고정함).
 *
 * 몽골 예외 분기는 실제 표본에 몽골 케이스가 없어서, 이 로직이 실제로 어떻게 동작하는지
 * 보여주기 위한 가상 예시 3건을 별도로 덧붙였다(실제 공고 데이터 아님 — 표시로 구분).
 *
 * 사용법: npm run validate:overseas-venue
 */
import { detectOverseasVenue, loadMongoliaKeywords } from "../src/matching/overseasVenueFilter.js";
import { OVERSEAS_VENUE_SAMPLES } from "../test/fixtures/overseasVenueSamples.js";

interface IllustrativeCase {
  title: string;
  note: string;
}

const ILLUSTRATIVE_MONGOLIA_CASES: IllustrativeCase[] = [
  { title: "2026 몽골 울란바토르 국제무역박람회 한국관 설치 용역", note: "국가명 '몽골'로 매치 → 자동배제 예외" },
  { title: "2027 울란바토르 국제무역박람회 한국관 조성 사업", note: "국가명 없이 도시명 '울란바토르'만으로도 매치 → 자동배제 예외" },
  { title: "무릉도원 관광지 조성 및 전시관 설치 용역", note: "'무릉' 오탐 위험 시연 — 하지만 '박람회/엑스포/전시회'+'한국관/단체관' 조합이 없어 애초에 매치 자체가 안 됨(자동배제 대상 아님)" },
];

function formatBool(value: boolean): string {
  return value ? "O" : "X";
}

function main(): void {
  const mongoliaKeywords = loadMongoliaKeywords();
  console.log(`몽골 판별 키워드(${mongoliaKeywords.length}개): ${mongoliaKeywords.join(", ")}\n`);

  console.log("===== 1) 표본 8건 재현 (해외현지사업 4건 + 해외테마사업 4건) =====\n");
  const rows = OVERSEAS_VENUE_SAMPLES.map((sample) => {
    const result = detectOverseasVenue(sample.title, mongoliaKeywords);
    const matches = result.isOverseasVenue === sample.expectedOverseasVenue;
    return { sample, result, matches };
  });

  for (const { sample, result, matches } of rows) {
    console.log(`[${matches ? "일치" : "!! 불일치 !!"}] ${sample.noticeNo}`);
    console.log(`  제목: ${sample.title}`);
    console.log(
      `  기대=${formatBool(sample.expectedOverseasVenue)} / 실제매칭=${formatBool(
        result.isOverseasVenue
      )} / 자동배제=${formatBool(result.shouldAutoExclude)}`
    );
    console.log("");
  }

  const positives = rows.filter((r) => r.sample.expectedOverseasVenue);
  const truePositives = positives.filter((r) => r.result.isOverseasVenue).length;
  const negatives = rows.filter((r) => !r.sample.expectedOverseasVenue);
  const falsePositives = negatives.filter((r) => r.result.isOverseasVenue).length;
  const recall = positives.length > 0 ? (truePositives / positives.length) * 100 : NaN;
  const precisionDenominator = truePositives + falsePositives;
  const precision = precisionDenominator > 0 ? (truePositives / precisionDenominator) * 100 : NaN;

  console.log("===== 요약 =====");
  console.log(`재현율(해외현지사업 중 정탐): ${truePositives}/${positives.length} = ${recall.toFixed(1)}%`);
  console.log(
    `정밀도(전체 매칭 중 정탐, 오탐 ${falsePositives}건): ${truePositives}/${precisionDenominator} = ${precision.toFixed(
      1
    )}%`
  );

  console.log("\n===== 2) 몽골 예외 분기 시연 (실제 공고 아님 — 가상 예시) =====\n");
  for (const { title, note } of ILLUSTRATIVE_MONGOLIA_CASES) {
    const result = detectOverseasVenue(title, mongoliaKeywords);
    console.log(`제목: ${title}`);
    console.log(`  설명: ${note}`);
    console.log(
      `  매칭=${formatBool(result.isOverseasVenue)} / 몽골=${formatBool(result.isMongolia)}` +
        (result.matchedMongoliaKeyword ? ` (매칭 키워드: ${result.matchedMongoliaKeyword})` : "") +
        ` / 자동배제=${formatBool(result.shouldAutoExclude)}`
    );
    console.log("");
  }

  const allMatched = rows.every((r) => r.matches);
  if (!allMatched) {
    console.error("표본 재현 결과가 설계안의 주장과 다릅니다 — 위 '!! 불일치 !!' 항목을 확인하세요.");
    process.exitCode = 1;
  }
}

main();
