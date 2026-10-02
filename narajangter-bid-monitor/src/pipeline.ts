import type { Env } from "./config/env.js";
import type { AppConfig } from "./config/loadJsonConfig.js";
import { fetchBidNotices } from "./api/bidNoticeApi.js";
import { fetchPreStandardNotices } from "./api/preStandardApi.js";
import { lookbackWindow } from "./api/dateUtil.js";
import type { FetchResult, FetchWindow } from "./api/types.js";
import { evaluateNotices } from "./matching/matchEngine.js";
import type { MatchedNotice } from "./matching/types.js";
import { loadSimilarityIndex } from "./similarity/loadCorpus.js";
import { calibrate } from "./similarity/calibrate.js";
import { fetchNoticeBodies, type NoticeBody } from "./api/noticeBody.js";
import { fetchJointBidStatuses } from "./api/jointBidApi.js";
import { loadMongoliaKeywords } from "./matching/overseasVenueFilter.js";
import { excludeExpiredNotices } from "./matching/deadline.js";
import { applyQualificationFilter } from "./matching/applyQualificationFilter.js";
import { fetchAllLicenseLimitGroups } from "./api/licenseLimitApi.js";
import type { ReportInput } from "./report/buildReport.js";
import { ApiError } from "./errors.js";
import type { NormalizedNotice } from "./api/types.js";
import type { DiagnoseContext } from "./matching/diagnose.js";
import { logger } from "./logger.js";

/**
 * ①수집 → ②규칙 추출 → ③필터링 까지를 수행하고 리포트 입력을 만든다.
 *
 * 정기 실행(src/index.ts)과 텔레그램 수동 조회(scripts/telegramBot.ts)가 같은 결과를
 * 보도록 이 한 곳에만 둔다 — 두 벌로 나뉘면 "수동으로 볼 때랑 자동 발송 내용이 다른"
 * 상황이 생기고, 테스트 결과를 믿을 수 없게 된다.
 *
 * 발송(⑥)과 시트 적재는 여기 들어가지 않는다. 호출하는 쪽이 정한다.
 */
export async function collectReportInput(
  env: Env,
  appConfig: AppConfig,
  options: {
    now?: Date;
    lookbackDays?: number;
    /**
     * 사전규격만 따로 볼 기간. 없으면 lookbackDays와 같다. 본공고를 "마감 전 전체"로 넓게 볼 때
     * 사전규격까지 같이 넓히면 이미 본공고로 넘어간 지난 사전규격이 쏟아지므로 따로 둔다.
     */
    preStandardLookbackDays?: number;
    /**
     * 본공고·면허제한정보를 디스크에 받아둔 것에 새로 올라온 것만 이어 받을지 (api/incrementalFetch.ts).
     * 넓은 기간을 자주 다시 보는 웹 UI "마감 전 공고 전체"용. 정기 발송은 매번 새로 받아야 하므로 기본 꺼짐.
     */
    incremental?: boolean;
    /**
     * 진행 상황 알림. 조회에 40초 안팎이 걸려서, 대화형으로 쓸 때는 중간 표시가 없으면
     * 멈춘 것처럼 보인다. 실패해도 조회 자체를 막으면 안 되므로 호출부가 아니라
     * 여기서 삼킨다.
     */
    onProgress?: (message: string) => void | Promise<void>;
    /** ③.5 공고 첨부(과업지시서)를 받아 ④의 질의를 과업 내용 전체로 넓힐지. 기본 꺼짐. */
    withAttachments?: boolean;
    /**
     * 공동수급 허용 여부를 g2b.go.kr 비공식 API로 조회해 붙일지. 기본 꺼짐.
     *
     * 정식 API가 아니라 언제든 깨질 수 있고, 본공고 한 건당 요청이 하나씩 더 나가
     * 조회 시간이 늘어난다. 표시 전용 부가 정보라 급하지 않은 수동 조회(텔레그램/UI)에서는
     * 끄고, 실제 보고서가 나가는 정기 실행에서만 켠다.
     */
    withJointBidStatus?: boolean;
    /**
     * 수집한 공고 전체와 판정 맥락을 함께 돌려줄지 (웹 UI의 "제외된 공고"·공고번호 추적용).
     * 정기 실행에서는 필요 없고 메모리만 잡아먹으므로 기본 꺼짐.
     */
    withDiagnostics?: boolean;
    /**
     * 마감 지난 본공고도 같은 조건으로 걸러 closed로 따로 돌려줄지 (웹 UI의 "마감된 공고" 칸).
     * 지난 공고를 다시 찾아보거나 참고하는 용도라 첨부는 받지 않는다. 정기 보고에는 쓰지 않는다.
     */
    withClosed?: boolean;
  } = {}
): Promise<CollectedInput> {
  const notify = async (message: string): Promise<void> => {
    if (!options.onProgress) return;
    try {
      await options.onProgress(message);
    } catch (err) {
      logger.warn("진행 상황 알림 실패 (조회는 계속합니다)", { error: String(err) });
    }
  };

  const now = options.now ?? new Date();
  const window: FetchWindow = lookbackWindow(now, options.lookbackDays ?? env.lookbackDays);
  const preStandardWindow: FetchWindow =
    options.preStandardLookbackDays === undefined ? window : lookbackWindow(now, options.preStandardLookbackDays);

  logger.info("조회 시작", {
    window: { begin: window.begin.toISOString(), end: window.end.toISOString() },
    dryRun: env.dryRun,
  });

  await notify("공고 목록을 불러오는 중…");

  // 면허제한정보는 "어떤 공고가 매칭됐는지"와 무관하게 조회기간 전체를 받아온다.
  // 그래서 공고 조회가 끝나기를 기다릴 이유가 없고, 여기서 같이 출발시킨다.
  // 순차로 돌리면 두 조회 시간이 그대로 더해지지만, 동시에 돌리면 둘 중 긴 쪽만 걸린다.
  // 이 함수는 내부에서 오류를 삼키고 빈 Map을 돌려주므로 거부(reject)되지 않는다 —
  // 매칭이 0건이라 아래에서 await하지 않게 되더라도 안전하다.
  const licenseGroupsPromise = fetchAllLicenseLimitGroups(env, window, { incremental: options.incremental });

  const [bidResults, preStandardResults] = await Promise.all([
    fetchBidNotices(env, window, { incremental: options.incremental }),
    fetchPreStandardNotices(env, preStandardWindow),
  ]);

  const totalFetchCalls = bidResults.length + preStandardResults.length;
  const failedCalls: FetchResult[] = [...bidResults, ...preStandardResults].filter((r) => r.failed);

  if (failedCalls.length === totalFetchCalls) {
    throw new ApiError("전체조회", "본공고/사전규격 조회가 모두 실패했습니다. API 키/네트워크 상태를 확인하세요.");
  }

  const fetchedCount =
    bidResults.reduce((sum, r) => sum + r.notices.length, 0) +
    preStandardResults.reduce((sum, r) => sum + r.notices.length, 0);
  await notify(`공고 ${fetchedCount.toLocaleString("ko-KR")}건 수집 완료 · 조건 매칭 중…`);

  const mongoliaKeywords = loadMongoliaKeywords();
  const { open: openBidNotices, expiredCount } = excludeExpiredNotices(
    bidResults.flatMap((r) => r.notices),
    now
  );
  logger.info("마감 지난 본공고 제외", { 제외: expiredCount });
  const bidMatchesBeforeQualificationFilter = evaluateNotices(openBidNotices, appConfig, mongoliaKeywords);
  const preStandardMatches = evaluateNotices(
    preStandardResults.flatMap((r) => r.notices),
    appConfig,
    mongoliaKeywords
  );

  // 사전규격은 대응하는 면허제한 조회 API가 없어 자격조건 필터 대상이 아니다 (본공고만 적용).
  logger.info("자격조건 필터 적용 시작", { 대상: bidMatchesBeforeQualificationFilter.length });
  await notify(
    `매칭 ${bidMatchesBeforeQualificationFilter.length + preStandardMatches.length}건 · 참가자격 확인 중…`
  );
  const bidMatches = await applyQualificationFilter(
    env,
    appConfig,
    bidMatchesBeforeQualificationFilter,
    window,
    licenseGroupsPromise
  );

  logger.info("매칭 결과", {
    본공고: bidMatches.length,
    사전규격: preStandardMatches.length,
    실패한조회: failedCalls.length,
  });

  const allMatches = [...bidMatches, ...preStandardMatches];

  // 공동수급 허용 여부 — 걸러낸 본공고에만 (사전규격은 상세 API 자체가 없음).
  // 표시 전용이라 실패해도 리포트를 막지 않는다.
  if (options.withJointBidStatus) {
    await notify(`공동수급 허용 여부 확인 중… (${bidMatches.length}건)`);
    let jointBidStatuses = new Map<string, string>();
    try {
      jointBidStatuses = await fetchJointBidStatuses(
        bidMatches.map((m) => m.notice),
        { intervalMs: env.apiRequestIntervalMs }
      );
    } catch (err) {
      logger.warn("공동수급 여부 조회 실패 (표시 전용 정보라 계속 진행합니다)", { error: String(err) });
    }
    for (const match of bidMatches) {
      const value = jointBidStatuses.get(match.notice.noticeNo);
      if (value) match.jointBidStatus = value;
    }
    logger.info("공동수급 여부 조회", { 대상: bidMatches.length, 확보: jointBidStatuses.size });
  }

  // ③.5 공고 첨부(과업지시서·제안요청서) 수집 — 걸러낸 공고에만.
  //
  // OpenAPI가 주는 본문은 제목 한 줄뿐이라, 첨부를 읽어야 ④의 질의가 과업 내용 전체가 된다.
  // 다운로드가 붙으므로 기본은 꺼두고 호출부가 켜게 했다 — 주간 실행에서는 켜고,
  // 빠른 확인이 필요한 텔레그램 수동 조회에서는 끄는 식으로 쓴다.
  let bodies = new Map<string, NoticeBody>();
  if (options.withAttachments) {
    await notify(`과업지시서 첨부 확인 중… (${allMatches.length}건)`);
    bodies = await fetchNoticeBodies(
      allMatches.map((m) => m.notice),
      { intervalMs: env.apiRequestIntervalMs }
    );
    logger.info("공고 첨부 본문 수집", { 대상: allMatches.length, 확보: bodies.size });
  }

  // ④ 싱크로율 — 걸러낸 공고에만 매긴다. 전체 수천 건에 매겨봐야 어차피 ③에서 떨어질
  // 공고라 계산이 낭비고, 리포트에 나가는 건 여기 남은 것들뿐이다.
  await notify("과거 수행사업과 대조 중…");
  attachSimilarity(allMatches, bodies);

  const result: CollectedInput = {
    generatedAt: now,
    window,
    bid: { matches: bidMatches, failures: bidResults.filter((r) => r.failed) },
    preStandard: { matches: preStandardMatches, failures: preStandardResults.filter((r) => r.failed) },
  };

  if (options.withClosed) {
    const openNos = new Set(openBidNotices.map((n) => n.noticeNo));
    const expired = bidResults.flatMap((r) => r.notices).filter((n) => !openNos.has(n.noticeNo));
    const closed = await applyQualificationFilter(
      env,
      appConfig,
      evaluateNotices(expired, appConfig, mongoliaKeywords),
      window,
      licenseGroupsPromise
    );
    attachSimilarity(closed, new Map());
    result.closed = closed;
    logger.info("마감된 본공고 매칭", { 대상: expired.length, 매칭: closed.length });
  }

  if (options.withDiagnostics) {
    // 면허제한정보 조회는 내부에서 오류를 삼키고 빈 Map을 주므로 여기서 거부되지 않는다.
    const licenseGroups = await licenseGroupsPromise;
    result.diagnostics = {
      notices: [...bidResults.flatMap((r) => r.notices), ...preStandardResults.flatMap((r) => r.notices)],
      context: { config: appConfig, mongoliaKeywords, now, licenseGroups },
    };
  }
  return result;
}

/** 수집한 공고 전체 + 판정 맥락. 어떤 공고든 matching/diagnose.ts로 단계별 판정을 다시 돌릴 수 있다. */
export interface CollectionDiagnostics {
  notices: NormalizedNotice[];
  context: DiagnoseContext;
}

export type CollectedInput = ReportInput & { diagnostics?: CollectionDiagnostics; closed?: MatchedNotice[] };

/**
 * 매칭된 공고에 싱크로율을 붙인다 (제자리 수정).
 *
 * 코퍼스가 없으면 인덱스가 비어 있고 findSimilar가 0을 돌려주는데, 그때는 필드를 아예
 * 안 채운다. 0.000이라고 적어두면 "안 비슷하다"는 판단처럼 보이지만 실제로는
 * "비교할 자료가 없다"는 뜻이라 서로 다르다.
 */
export function attachSimilarity(matches: MatchedNotice[], bodies?: Map<string, NoticeBody>): void {
  const index = loadSimilarityIndex();
  if (index.size === 0) return;

  for (const match of matches) {
    const body = bodies?.get(match.notice.noticeNo);
    const result = index.findSimilar(match.notice.title, 3, body ? { body: body.text } : {});
    match.similarity = {
      score: result.maxScore,
      shown: calibrate(result.maxScore, result.basis),
      basis: result.basis,
      ...(body ? { sourceFile: body.sourceFile } : {}),
      top: result.top.map((t) => ({ id: t.id, name: t.name, year: t.year, score: t.score })),
    };
  }
}

/** 조회 단계에서 일부 오퍼레이션이 실패했는지 (종료 코드 결정용) */
export function hasFetchFailures(input: ReportInput): boolean {
  return input.bid.failures.length > 0 || input.preStandard.failures.length > 0;
}
