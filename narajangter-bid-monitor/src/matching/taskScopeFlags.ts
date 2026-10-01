/**
 * 과업지시서·제안요청서 본문에서 지일 본업(설계·제작·설치) 밖의 업무가 과업에 섞여 있는지 찾는다.
 *
 * 제목만으로는 안 보인다. 2026-10-01 실측: 「K-거상」기획전시관 콘텐츠 개선·개발 용역은 제목상
 * 전시 제작이지만 과업 범위에 전시품 대여, 유물 운송·유물종합보험, 홍보 전략, 운영이 함께 들어 있었고,
 * 송파책박물관 기획특별전은 "전시유물 운송 및 유물종합보험 가입"이 세부 과업 하나로 붙어 있었다.
 *
 * **판정이 아니라 경고다.** 이런 항목이 있어도 제작·설치가 중심이면 참가할 수 있다 — 하청·비용을
 * 견적에 넣어야 한다는 신호로 화면에 띄운다. 공고를 목록에서 빼지 않는다.
 */

export type ScopeFlagKind = "운송" | "대여" | "운영" | "홍보·도록" | "휴게공간";

export interface ScopeFlag {
  kind: ScopeFlagKind;
  /** 근거 문장 (본문에서 잘라낸 것) */
  sentence: string;
}

const OBJECT = "(?:유물|작품|전시품|출품\\s*자료|소장\\s*자료|소장품|전시\\s*자료)";

/*
 * 2026-10-01 리스트 97건 실측으로 걸러낸 오탐:
 *   "유물의 반입·반출을 위한 수장고 조성"(공간 설계) · "대여유물을 중심으로 재구성"(박물관 소장품 설명)
 *   "운영요원의 교육" · "운영요원이 최소화되도록 설계"(설계 조건) · "AI 도슨트"(콘텐츠 이름)
 *   "행사 운영이 가능한 음향 환경"(설계 조건) · "상주인력 등 상세히 기재"(공사 인력 계획)
 *   "SNS 홍보를 위한 포토존"(전시물 설명) · "기타자유업(행사대행업)"(참가자격 업종명)
 */
const RULES: { kind: ScopeFlagKind; pattern: RegExp }[] = [
  // "물자 운송 경로 디지털 맵"(전시 콘텐츠 이름) 같은 말에 걸리지 않게 운송 대상(유물·작품…)이 붙은 것만 본다
  { kind: "운송", pattern: new RegExp(`${OBJECT}\\s*(?:의\\s*)?(?:운송|이송|운반|포장|해포)`, "g") },
  { kind: "운송", pattern: new RegExp(`(?:운송|이송|포장)\\s*(?:및|·|ㆍ)?\\s*${OBJECT}`, "g") },
  { kind: "운송", pattern: /유물\s*종합\s*보험|적하\s*보험|운송\s*보험|운송료/g },
  // 우리가 빌려 와야 하는 경우만 — "전시품 대여", "소장 자료 공식 대여"
  { kind: "대여", pattern: new RegExp(`${OBJECT}\\s*(?:의\\s*)?(?:공식\\s*)?(?:대여|차용)(?!\\s*유물)`, "g") },
  // 전시 기간 중 시설 유지보수는 제작·설치 업체의 통상 하자 책임이라 보지 않는다 — 사람을 붙여 운영하는 일만
  {
    kind: "운영",
    pattern: /(?:운영|안내|진행|의전)\s*요원(?!\s*(?:의|에\s*대한)?\s*교육)(?!\s*(?:이|을)?\s*최소)|도슨트\s*(?:인력|배치|운영|채용)|전시\s*운영\s*(?:대행|인력)|행사\s*(?:운영|진행|대행)(?!\s*업)(?!\s*(?:이|이\s*가능|가능))|관람객\s*응대|인력\s*섭외/g,
  },
  // "조화되도록 제작"의 "도록"에 걸리지 않게 "전시도록"이거나 앞 글자가 한글이 아닐 때만
  { kind: "홍보·도록", pattern: /홍보\s*전략|홍보\s*매체\s*운영|온\s*[·ㆍ.\-]?\s*오프라인\s*홍보|(?:전시\s*도록|(?<![가-힣])도록)\s*(?:제작|발간|편집|기획)/g },
];

/** "별도 발주", "발주처에서 수행" 같은 말이 같은 문장에 있으면 우리 과업이 아니다 */
const NOT_OURS = /별도\s*(?:발주|계약|용역|추진)|발주\s*(?:처|기관)에서\s*(?:직접|수행|진행|부담)|과업\s*(?:에서\s*)?제외|제외한다|포함하지\s*않/;

/** 운영요원을 "교육하라", "최소화하라", "매뉴얼을 만들라"는 문장은 운영 업무가 아니라 설계·인수인계 조건이다 */
const OPS_NOT_OURS = /교육|매뉴얼|최소/;

/**
 * "전시품 포장ㆍ운송ㆍ등록이 담긴 기록영상"처럼 운송·대여가 **콘텐츠의 주제**인 경우 — 바로 뒤에 "담긴/담은/기록영상"이 온다.
 * 2026-10-01 국립충주박물관 중원팔경(프로젝션 매핑·수장대 제작) 사전규격이 이 문구로 운송 업무가 있는 것처럼 잡혔다.
 */
const AS_CONTENT = /^[\s가-힣ㆍ·,]{0,16}?(?:이|을|를)?\s*(?:담긴|담은|담아|소개하는|보여주는|기록\s*영상|영상)/;

/** 목차 줄("과업 범위 ------ 7")은 건너뛴다 */
const TOC = /-{6,}|·{6,}|…{3,}/;

/** 항목 경계. 한글 문서의 글머리 기호는 사용자 정의 영역 문자(U+F000~F8FF)로 추출되는 경우가 많다. */
const BOUNDARY = /(?:[•○◦▪■□◆◇※-]|(?<![\d.])\d{1,2}\)|(?<![가-힣])[가-하]\.|다\.(?=\s)|함\.(?=\s)|음\.(?=\s)|(?<=\s)-\s)/g;

/** 일치한 위치를 감싸는 항목 한 줄(앞뒤 항목 기호 사이)을 잘라낸다 */
function sentenceAround(flat: string, index: number, length: number): string {
  const from = Math.max(0, index - 140);
  const before = flat.slice(from, index);
  const starts = [...before.matchAll(BOUNDARY)];
  const last = starts.at(-1);
  const start = last ? from + last.index! : from;
  const after = flat.slice(index + length, index + length + 140);
  const end = after.search(BOUNDARY);
  const stop = end >= 0 ? index + length + end : Math.min(flat.length, index + length + 140);
  return flat.slice(start, stop).replace(/^[\s•○◦▪■□◆◇※-\-]+/, "").trim();
}

const PURPOSE = /사\s*업\s*목\s*적|추\s*진\s*목\s*적|과\s*업\s*목\s*적|용\s*역\s*목\s*적/;
const PURPOSE_SPAN = 300;
const REST_WORDS = /휴\s*식|휴\s*게|독\s*서|쉼\s*터|쉼\s*(?:공간|의\s*공간)|라운지|북\s*카페/;
const EXHIBIT_WORDS = /전\s*시|체\s*험|콘\s*텐\s*츠|실\s*감|미\s*디\s*어|조형물|놀이/;

/**
 * 사업 목적이 휴게·독서 공간 조성인 공고 — 전시가 아니라 방문객 쉼터·라운지를 꾸미는 일이다.
 * 사업 목적 부분(앞 300자)에 휴식·휴게·독서·쉼터·라운지가 있고 전시·체험·콘텐츠·조형물·놀이가 **없을 때만** 본다.
 *
 * 2026-10-01 실측: 독서왕김득신문학관 '늘 책봄 공간' 조성("방문객의 학습, 독서, 휴식 등을 위한 공간 제공")은
 * 제목 키워드 '문학관'으로 들어왔지만 담당자가 지일 업무가 아니라고 판단했다. 첨부 476개 중 이 규칙에 걸린 것은
 * 그 1건이고, 휴식·휴게가 목적에 들어간 지일 과거 실적 7건(성성호수공원 조형물, 삼탄역 테마공원, 토이로봇관 등)은
 * 모두 조형물·놀이·전시·콘텐츠가 함께 있어 걸리지 않았다.
 */
function detectRestSpace(flat: string): ScopeFlag | null {
  const m = PURPOSE.exec(flat);
  if (!m) return null;
  const purpose = flat.slice(m.index, m.index + PURPOSE_SPAN);
  const rest = REST_WORDS.exec(purpose);
  if (!rest || EXHIBIT_WORDS.test(purpose)) return null;
  return { kind: "휴게공간", sentence: sentenceAround(flat, m.index + rest.index, rest[0].length) };
}

export function detectScopeFlags(text: string, perKind = 3): ScopeFlag[] {
  const flat = text.replace(/\s+/g, " ");
  const out: ScopeFlag[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of RULES) {
    for (const m of flat.matchAll(pattern)) {
      if (out.filter((f) => f.kind === kind).length >= perKind) break;
      const sentence = sentenceAround(flat, m.index!, m[0].length);
      if (TOC.test(sentence) || NOT_OURS.test(sentence)) continue;
      if (kind === "운영" && OPS_NOT_OURS.test(sentence)) continue;
      if ((kind === "운송" || kind === "대여") && AS_CONTENT.test(flat.slice(m.index! + m[0].length, m.index! + m[0].length + 30))) continue;
      const key = sentence.replace(/\s+/g, "").slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, sentence });
    }
  }
  const rest = detectRestSpace(flat);
  if (rest) out.push(rest);
  return out;
}
