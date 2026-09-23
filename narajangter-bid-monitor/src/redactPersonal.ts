/**
 * 문서 텍스트에서 **개인정보**를 가린다. 외부(LLM API 등)로 보내기 직전의 마지막 관문.
 *
 * redact.ts와 역할이 다르다:
 *  - redact.ts     → 우리 **비밀값**(API 키, 봇 토큰, 개인키)이 로그·메일에 새는 걸 막는다
 *  - redactPersonal.ts → 문서에 담긴 **사람에 관한 정보**가 외부 서비스로 나가는 걸 막는다
 *
 * 왜 필요한가: 과업지시서·수행능력평가서를 추출해보면 실제로 이런 것들이 나온다.
 *   "담 당 성 명 소 속 전화번호 E-mail 이슬 강릉시청 체육과 033-640-5994 lololii@korea.kr"
 *   "[서식 14] 참여 인력 이력 사항 성 명 김도형 ... 생년월일 19800408 최종학력 안동대학교"
 * 발주기관 담당자와 자사 직원의 성명·생년월일·연락처·학력·경력이 통째로 들어 있다.
 *
 * 설계 원칙 — **지우지 말고 치환한다.** `[성명]`, `[전화번호]`처럼 자리표시자를 남겨야
 * LLM이 "여기에 사람 이름이 있었다"는 문맥을 잃지 않는다. 그냥 삭제하면 문장이 깨져서
 * ⑤단계 판단 품질이 떨어진다.
 *
 * 한계 — 라벨 없이 본문에 흘러나온 이름("김도형 차장이 총괄하며")은 못 잡는다. 한국어
 * 이름은 일반 명사와 형태가 겹쳐서(예: 이슬, 하늘) 패턴만으로 가려내면 멀쩡한 단어까지
 * 지운다. 그래서 **이름은 라벨 뒤에 오는 것만** 가린다. 본문 이름까지 확실히 막아야 하면
 * knownNames로 실제 직원 명단을 넘기는 방식을 쓴다.
 */

export interface RedactPersonalOptions {
  /**
   * 반드시 가려야 하는 이름 목록 (자사 직원 명단 등). 라벨이 없어도 가린다.
   * 2자 미만은 흔한 글자와 겹쳐 본문을 훼손하므로 무시한다.
   */
  knownNames?: string[];
  /** 이메일 도메인은 남길지 (기관 식별에 쓸모가 있어 기본은 남김) */
  keepEmailDomain?: boolean;
}

export interface RedactPersonalResult {
  text: string;
  /** 종류별로 몇 건을 가렸는지 — 마스킹이 실제로 동작했는지 확인용 */
  counts: Record<string, number>;
}

interface Rule {
  label: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

/**
 * 성명 라벨. 한글 문서는 항목명을 글자 사이 공백으로 늘려 쓰므로("성 명") 공백을 허용한다.
 * 뒤따르는 이름은 2~4자 한글로 본다 — 5자 이상이면 이름이 아니라 다음 항목까지 삼킨 것이다.
 */
const NAME_LABEL = /(성\s*명|대\s*표\s*자(?:\s*성\s*명)?|담\s*당\s*자|작\s*성\s*자|책\s*임\s*자)(\s*(?::|：)?\s*)([가-힣]{2,4})(?![가-힣])/g;

const RULES: Rule[] = [
  {
    // 법인등록번호를 **라벨로** 먼저 잡는다.
    //
    // 법인등록번호(110111-4182971)와 주민등록번호(800408-1234567)는 형태가 6자리-7자리로
    // 똑같고, 법인번호 앞 6자리가 유효한 날짜처럼 보이는 경우도 있어(110111 = 11년 1월 11일)
    // 숫자만으로는 구분할 수 없다. 실제로 이 규칙 순서를 반대로 뒀더니 법인등록번호가
    // [주민등록번호]로 가려졌다. 개인정보 보호 측면에서는 둘 다 가려지니 해가 없지만
    // 어떤 정보가 있었는지 잘못 알려주므로, 라벨이 있으면 라벨을 믿는다.
    label: "법인등록번호",
    pattern: /(법\s*인\s*등\s*록\s*번\s*호)(\s*(?::|：)?\s*)(?<!\d)\d{6}\s*-\s*\d{7}(?!\d)/g,
    replace: (_m, label, gap) => `${label}${gap}[법인등록번호]`,
  },
  {
    // 라벨 없는 6-7자리는 주민등록번호로 본다 (뒷자리 첫 글자가 성별코드 1~4).
    // 사업수행능력 서류에 기술인력 주민번호가 들어가는 관행이 있어 막아둔다.
    label: "주민등록번호",
    pattern: /(?<!\d)(\d{6})\s*-\s*([1-4])\d{6}(?!\d)/g,
    replace: () => "[주민등록번호]",
  },
  {
    // 위 두 규칙에 안 걸린 6-7자리 (뒷자리가 5~9로 시작하는 법인번호 등)
    label: "법인등록번호",
    pattern: /(?<!\d)\d{6}\s*-\s*\d{7}(?!\d)/g,
    replace: () => "[법인등록번호]",
  },
  {
    // 사업자등록번호 (206-86-36338). 회사 식별자라 엄밀히는 개인정보가 아니지만
    // 외부로 흘릴 이유가 없어 같이 가린다.
    //
    // 구분자로 공백도 받는다 — OCR이 하이픈을 자주 놓쳐서 `206 86 36338`로 읽힌다
    // (실측). 자릿수가 3-2-5로 고정이라 연도·면적 같은 숫자와 헷갈릴 여지는 작다.
    label: "사업자등록번호",
    pattern: /(?<![\d-])\d{3}\s*[-\s]\s*\d{2}\s*[-\s]\s*\d{5}(?![\d-])/g,
    replace: () => "[사업자등록번호]",
  },
  {
    label: "이메일",
    pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    replace: (_m, domain) => `[이메일]@${domain}`,
  },
  {
    // 휴대전화 + 유선전화. 지역번호 2~3자리, 국번 3~4자리.
    label: "전화번호",
    pattern: /(?<![\d-])0\d{1,2}\s*-\s*\d{3,4}\s*-\s*\d{4}(?![\d-])/g,
    replace: () => "[전화번호]",
  },
  {
    // 생년월일. "생년월일 19800408" / "생 년 월 일 : 1980-04-08" 둘 다.
    // 라벨 없는 8자리 숫자는 건드리지 않는다 — 사업번호·날짜와 구분이 안 된다.
    label: "생년월일",
    pattern: /(생\s*년\s*월\s*일)(\s*(?::|：)?\s*)(\d{4}\s*[-.]?\s*\d{1,2}\s*[-.]?\s*\d{1,2}|\d{6,8})/g,
    replace: (_m, label, gap) => `${label}${gap}[생년월일]`,
  },
  {
    // 계좌번호 (기관/자릿수가 제각각이라 라벨 앵커로만 잡는다)
    label: "계좌번호",
    pattern: /(계\s*좌\s*번\s*호)(\s*(?::|：)?\s*)([\d-]{8,})/g,
    replace: (_m, label, gap) => `${label}${gap}[계좌번호]`,
  },
];

export function redactPersonal(text: string, options: RedactPersonalOptions = {}): RedactPersonalResult {
  let result = text;
  const counts: Record<string, number> = {};

  const bump = (label: string, n = 1): void => {
    if (n > 0) counts[label] = (counts[label] ?? 0) + n;
  };

  for (const rule of RULES) {
    if (rule.label === "이메일" && options.keepEmailDomain === false) {
      result = result.replace(rule.pattern, (m) => {
        bump("이메일");
        void m;
        return "[이메일]";
      });
      continue;
    }
    result = result.replace(rule.pattern, (...args) => {
      bump(rule.label);
      const groups = args.slice(1, -2) as string[];
      return rule.replace(args[0] as string, ...groups);
    });
  }

  // 라벨 뒤 성명
  result = result.replace(NAME_LABEL, (_m, label: string, gap: string) => {
    bump("성명");
    return `${label}${gap}[성명]`;
  });

  // 명단으로 넘어온 이름은 라벨 없이도 가린다.
  for (const name of options.knownNames ?? []) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    const parts = result.split(trimmed);
    if (parts.length > 1) {
      bump("성명", parts.length - 1);
      result = parts.join("[성명]");
    }
  }

  return { text: result, counts };
}

/** 가려진 항목을 사람이 읽을 수 있는 한 줄로 요약한다 (로그·리포트용). */
export function describeRedactions(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return "가린 개인정보 없음";
  return entries.map(([label, n]) => `${label} ${n}건`).join(" · ");
}
