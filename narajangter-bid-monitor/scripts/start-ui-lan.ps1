# 입찰 공고 검토 화면을 팀 공유 모드로 띄운다 — Windows 작업 스케줄러가 로그인할 때 이 파일을 실행한다.
#
#   등록:  scripts\register-ui-task.ps1  (한 번만)
#   기록:  output\ui-server.log  (최근 실행분. 팀원 공유 주소도 여기 첫머리에 찍힌다)
#
# 서버가 죽으면 작업 스케줄러가 1분 뒤 다시 띄운다(등록 설정). 창은 숨긴다.
# 이 파일은 BOM 있는 UTF-8로 저장해야 한다 — Windows PowerShell 5.1이 BOM 없는 한글을 깨뜨린다.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root "output") | Out-Null
$log = Join-Path $root "output\ui-server.log"
[IO.File]::WriteAllText($log, "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') start ===`r`n", (New-Object Text.UTF8Encoding $false))
# 80번 포트로 띄워 주소에 :5173이 붙지 않게 한다 — 팀원 주소는 http://jiil-bid.local (방화벽 허용은 register-ui-task.ps1)
$env:UI_PORT = "80"
# 출력은 cmd로 그대로 덧붙인다 — PowerShell 5.1의 >> 는 UTF-16으로 바꿔 써서 기록이 깨진다
& cmd.exe /c "npm run ui -- --lan >> `"$log`" 2>&1"
exit $LASTEXITCODE
