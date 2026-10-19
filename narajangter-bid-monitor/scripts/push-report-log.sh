#!/usr/bin/env bash
# 보고에 나간 공고 목록(output/report-log/*.json)을 저장소의 report-log 브랜치에 올린다 — 사내 화면이 받아 판단 기록에
# '미판단'으로 쌓는다 (src/state/reportLog.ts, scripts/ui.ts pullReportLog). GitHub Actions에서만 돈다.
#
# 개발 브랜치에 매일 커밋이 쌓이지 않게 기록 전용 브랜치를 따로 쓴다. 브랜치가 없으면 새로 만든다.
# 매일·주간 보고가 같은 시각에 돌 수 있어, 올리다 밀리면 받아서 다시 올린다.
# 저장소가 공개라서 이 파일들에는 나라장터에 공개된 공고 정보만 들어 있다 (판단·담당자 이름은 넣지 않는다).
#
#   필요: GH_TOKEN (contents: write), GITHUB_REPOSITORY
set -euo pipefail

shopt -s nullglob
files=("$PWD"/output/report-log/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "올릴 보고 기록이 없습니다 (보고를 보내지 않았거나 0건)."
  exit 0
fi

# REPORT_LOG_REMOTE: 시험용 — 이 PC의 임시 저장소에 올려 볼 때만 쓴다
url="${REPORT_LOG_REMOTE:-https://x-access-token:${GH_TOKEN:-}@github.com/${GITHUB_REPOSITORY:-}.git}"
dir="${RUNNER_TEMP:-/tmp}/report-log"
rm -rf "$dir"
if git ls-remote --exit-code --heads "$url" report-log >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch report-log "$url" "$dir"
else
  git init --quiet "$dir"
  git -C "$dir" checkout --quiet --orphan report-log
  git -C "$dir" remote add origin "$url"
fi

cd "$dir"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
mkdir -p reports
cp "${files[@]}" reports/
git add reports
if git diff --cached --quiet; then
  echo "보고 기록에 바뀐 것이 없습니다."
  exit 0
fi
git commit --quiet -m "보고 기록 $(basename -a "${files[@]}" | tr '\n' ' ')"

for attempt in 1 2 3; do
  if git push --quiet origin report-log; then
    echo "보고 기록을 올렸습니다: $(basename -a "${files[@]}" | tr '\n' ' ')"
    exit 0
  fi
  echo "올리다 밀렸습니다 — 받아서 다시 올립니다 (${attempt}/3)"
  sleep $((attempt * 5))
  git pull --quiet --rebase origin report-log
done
echo "보고 기록을 올리지 못했습니다." >&2
exit 1
