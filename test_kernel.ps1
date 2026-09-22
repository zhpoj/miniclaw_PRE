# test_kernel.ps1 — terminal kernel test for MiniAgent (no frontend needed).
# Run in PowerShell:  .\test_kernel.ps1
# Override URL:      $env:MINIAGENT_URL = "http://localhost:3100"; .\test_kernel.ps1
$base = $env:MINIAGENT_URL
if (-not $base) { $base = "http://localhost:3100" }

function Extract-Text($v) {
  if ($null -eq $v) { return }
  if ($v -is [string]) { if ($v.Trim()) { Write-Output $v } }
  elseif ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
    foreach ($i in $v) { Extract-Text $i }
  }
  elseif ($v -is [System.Management.Automation.PSCustomObject]) {
    if ($v.role -eq 'assistant' -and ($v.content -or $v.text)) {
      $c = if ($v.content) { $v.content } else { $v.text }
      if ($c -is [string]) { Write-Output $c }
      elseif ($c -is [System.Collections.IEnumerable]) { foreach ($p in $c) { if ($p.text) { Write-Output $p.text } } }
    }
    foreach ($k in $v.PSObject.Properties.Name) { Extract-Text $v.$k }
  }
}

$health = Invoke-RestMethod "$base/api/agent/health"
Write-Host ("[engine] {0}@{1} mode={2} cwd={3}" -f $health.engine.engine, $health.engine.version, $health.engine.mode, $health.engine.cwd)

$run = Invoke-RestMethod -Method Post -Uri "$base/api/agent/runs" -ContentType "application/json" -Body '{}'
$id = $run.id
Write-Host ("[run] id={0} model={1}/{2} cwd={3}" -f $id, $run.model.provider, $run.model.id, $run.cwd)

$cwd = $health.engine.cwd
$task = "Use the write tool to create a file at the absolute path $cwd/kernel_probe.txt whose content is exactly KERNEL_OK. Then use the read tool to read it back and tell me what you see. Do not create files anywhere else."
$body = @{ text = $task } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Method Post -Uri "$base/api/agent/runs/$id/prompt" -ContentType "application/json" -Body $body
Write-Host ("[prompt] accepted={0}" -f $r.status)

$all = @()
$since = 0; $settled = $false; $seenRunning = $false
while (-not $settled) {
  $e = Invoke-RestMethod "$base/api/agent/runs/$id/events?since=$since"
  foreach ($ev in $e.events) {
    $all += $ev
    Extract-Text $ev.payload | ForEach-Object { Write-Host ("[{0}] {1}" -f $ev.type, $_) }
  }
  if ($e.events.Count) { $since = $e.events[-1].seq + 1 }
  if ($e.run.status -eq 'running') { $seenRunning = $true }
  if ($e.run.status -eq 'error') { Write-Host ("[run error] " + $e.run.lastError); break }
  if ($e.run.status -eq 'idle' -and $seenRunning) { $settled = $true }
  if (-not $settled) { Start-Sleep -Milliseconds 1500 }
}

$probe = Join-Path $cwd "kernel_probe.txt"
$disk = $null
if (Test-Path $probe) { $disk = Get-Content $probe -Raw }
Write-Host "--- disk check ---"
Write-Host ("file: {0}" -f $probe)
Write-Host ("exists: {0} | content: {1}" -f ($null -ne $disk), $disk)
if ($disk -and $disk.Contains("KERNEL_OK")) { Write-Host "KERNEL TEST: PASS" } else { Write-Host "KERNEL TEST: FAIL" }
Remove-Item $probe -Force -ErrorAction SilentlyContinue
