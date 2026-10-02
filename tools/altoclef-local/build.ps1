$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSource = Join-Path $taskRoot 'altoclef'
$taskJdk = Get-ChildItem (Join-Path $taskRoot '.bot-state/build-tools') -Directory | Where-Object Name -Like 'jdk-21*' | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 21 local absent' }
$env:JAVA_HOME = $taskJdk.FullName
$env:GRADLE_USER_HOME = Join-Path $taskRoot '.bot-state/gradle-cache'
& (Join-Path $taskSource 'gradlew.bat') -p $taskSource ':1.18.2:build' --configure-on-demand --no-daemon '-Dorg.gradle.jvmargs=-Xmx3G' --console=plain
if ($LASTEXITCODE -ne 0) { throw 'Compilation AltoClef échouée' }
& (Join-Path $PSScriptRoot 'verify.ps1')
