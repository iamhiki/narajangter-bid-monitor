# 로그인하면 입찰 공고 검토 서버가 자동으로 뜨도록 Windows 작업 스케줄러에 등록한다. 한 번만 실행하면 된다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-ui-task.ps1
#
# 지우려면:  Unregister-ScheduledTask -TaskName "지일 입찰 공고 검토 서버" -Confirm:$false
$ErrorActionPreference = "Stop"
$name = "지일 입찰 공고 검토 서버"
$script = Join-Path $PSScriptRoot "start-ui-lan.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 기본값은 72시간 뒤 강제 종료라 실행 시간 제한을 없앤다. 죽으면 1분 간격으로 3번까지 다시 띄운다.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
# 로그인한 사용자 권한으로 돈다 — 나중에 회사 공유 폴더(네트워크 드라이브)에 쓸 때 이 계정의 접속 정보를 쓴다
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"등록됨: $name (로그인하면 자동 실행)"
