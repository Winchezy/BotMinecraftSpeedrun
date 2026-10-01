$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskSource = Join-Path $taskRoot '.bot-state/altoclef-source-019/altoclef-0.19'
$taskJdk = Get-ChildItem (Join-Path $taskRoot '.bot-state/build-tools') -Directory | Where-Object Name -Like 'jdk-21*' | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 21 local absent' }
$taskClasses = Join-Path $taskSource 'local-tests/classes'
& (Join-Path $taskJdk.FullName 'bin/javac.exe') -d $taskClasses (Join-Path $taskSource 'src/main/java/adris/altoclef/util/helpers/LocalSafetyPolicy.java') (Join-Path $taskSource 'src/main/java/adris/altoclef/util/helpers/InventoryCapacityPolicy.java') (Join-Path $taskSource 'src/main/java/adris/altoclef/util/helpers/WitherDefensePolicy.java') (Join-Path $taskSource 'local-tests/LocalSafetyPolicyTest.java') (Join-Path $taskSource 'local-tests/WitherDefensePolicyTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Compilation des tests échouée' }
& (Join-Path $taskJdk.FullName 'bin/java.exe') -cp $taskClasses LocalSafetyPolicyTest
if ($LASTEXITCODE -ne 0) { throw 'Tests échoués' }
& (Join-Path $taskJdk.FullName 'bin/java.exe') -cp $taskClasses WitherDefensePolicyTest
if ($LASTEXITCODE -ne 0) { throw 'Tests défense Wither échoués' }
