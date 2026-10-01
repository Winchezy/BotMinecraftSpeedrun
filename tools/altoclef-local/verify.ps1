$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskJar = Join-Path $taskRoot '.bot-state/altoclef-source-019/altoclef-0.19/versions/1.18.2/build/libs/altoclef-1.18.2-0.19-local.3.jar'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead($taskJar)
try {
    $taskReader = [System.IO.StreamReader]::new($taskArchive.GetEntry('fabric.mod.json').Open())
    try { $taskMetadata = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
    if ($taskMetadata.version -ne '1.18.2-0.19-local.3') { throw 'Version du mod inattendue' }
    foreach ($taskNested in $taskMetadata.jars) {
        if (-not $taskArchive.GetEntry($taskNested.file)) { throw "JAR intégré absent : $($taskNested.file)" }
    }
    foreach ($taskClass in @('LocalSafetyPolicy', 'CombatGroundHelper', 'InventoryCapacityPolicy', 'WitherDefensePolicy')) {
        if (-not $taskArchive.GetEntry("adris/altoclef/util/helpers/$taskClass.class")) { throw "Correction absente : $taskClass" }
    }
    if (-not $taskArchive.GetEntry('adris/altoclef/tasks/entity/WitherSkeletonDefenseTask.class')) { throw 'Défense Wither absente' }
    $taskClassCount = 0
    foreach ($taskEntry in $taskArchive.Entries) {
        if ($taskEntry.FullName.EndsWith('.class')) {
            $taskBinary = [System.IO.BinaryReader]::new($taskEntry.Open())
            try { $taskHeader = $taskBinary.ReadBytes(8) } finally { $taskBinary.Dispose() }
            if ($taskHeader.Length -ne 8) { throw 'Classe tronquée' }
            $taskMajor = [int]$taskHeader[6] * 256 + [int]$taskHeader[7]
            if ($taskMajor -gt 61) { throw "Classe incompatible Java 17 : $($taskEntry.FullName)" }
            $taskClassCount++
        }
    }
} finally { $taskArchive.Dispose() }
$taskSha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes($taskJar))).Replace('-','').ToLowerInvariant()
$taskResult = @{ artifact = $taskJar; version = $taskMetadata.version; java17Compatible = $true; classes = $taskClassCount; sha256 = $taskSha }
$taskResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot '.bot-state/altoclef-downloads/local-jar-validation.json') -Encoding UTF8
$taskResult | ConvertTo-Json
