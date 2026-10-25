// "Fix my PC": a read-only check-up of the usual problems (slow PC, full disk, Wi-Fi,
// printer, battery, pending restart, startup apps), and finding/restoring files from the
// Recycle Bin. Nothing here changes the system except restoring a file the user asked for.
const { runProcess } = require('./shell');

function ps(script, timeout = 40000) {
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; ${script}`],
    { timeoutMs: timeout, maxBuffer: 8 * 1024 * 1024 })
    .then((r) => {
      if (r.code !== 0 && !r.stdout) throw new Error(r.timedOut ? 'The check took too long.' : (r.stderr || 'the check failed').trim());
      try { return JSON.parse(String(r.stdout).trim() || 'null'); } catch { throw new Error('The check returned something unreadable.'); }
    });
}

const CHECKUP = `
$r = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$r.windows = "$($os.Caption) $($os.Version)"
$r.uptimeDays = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
$r.memory = @{ totalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); freeGB = [math]::Round($os.FreePhysicalMemory/1MB,1) }
$r.cpuLoad = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average)
$r.topMemory = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { @{ name = $_.ProcessName; MB = [math]::Round($_.WorkingSet64/1MB) } })
$r.topCpu = @(Get-Process | Where-Object { $_.CPU } | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { @{ name = $_.ProcessName; cpuSeconds = [math]::Round($_.CPU) } })
$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { @{ drive = $_.DeviceID; freeGB = [math]::Round($_.FreeSpace/1GB,1); totalGB = [math]::Round($_.Size/1GB,1) } })
$r.startupApps = @(Get-CimInstance Win32_StartupCommand | Select-Object -ExpandProperty Name -Unique)
$t = 0; Get-ChildItem $env:TEMP -Recurse -Force -File -ErrorAction SilentlyContinue | Select-Object -First 20000 | ForEach-Object { $t += $_.Length }; $r.tempGB = [math]::Round($t/1GB,2)
$sh = New-Object -ComObject Shell.Application; $rb = $sh.Namespace(10); $rbItems = @($rb.Items()); $rbSize = 0; foreach ($i in $rbItems) { $rbSize += $i.Size }
$r.recycleBin = @{ items = $rbItems.Count; GB = [math]::Round($rbSize/1GB,2) }
$pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
$r.restartPending = [bool]$pending
$w = netsh wlan show interfaces 2>$null | Out-String
if ($w -match 'SSID\\s+:\\s*(.+)') { $r.wifi = @{ network = $Matches[1].Trim(); signal = if ($w -match 'Signal\\s+:\\s*(\\d+)%') { [int]$Matches[1] } else { $null }; state = if ($w -match 'State\\s+:\\s*(\\w+)') { $Matches[1] } else { '' } } } else { $r.wifi = $null }
$r.internet = [bool](Test-Connection 1.1.1.1 -Count 1 -Quiet)
$r.dns = [bool](Resolve-DnsName www.google.com -QuickTimeout -ErrorAction SilentlyContinue)
$r.printers = @(Get-Printer | ForEach-Object { $jobs = @(Get-PrintJob -PrinterName $_.Name); @{ name = $_.Name; status = "$($_.PrinterStatus)"; default = $false; queued = $jobs.Count; errorJobs = @($jobs | Where-Object { "$($_.JobStatus)" -match 'Error|Blocked|Paused|Offline' }).Count } })
$def = (Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Printer | Where-Object Default).Name
foreach ($p in $r.printers) { if ($p.name -eq $def) { $p.default = $true } }
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$r.battery = if ($b) { @{ percent = $b.EstimatedChargeRemaining; charging = ($b.BatteryStatus -eq 2) } } else { $null }
$mp = Get-MpComputerStatus
$r.antivirus = if ($mp) { @{ on = [bool]$mp.RealTimeProtectionEnabled; daysSinceScan = $mp.QuickScanAge } } else { $null }
$r | ConvertTo-Json -Depth 5 -Compress
`;

// Plain-words findings, worst first.
function findings(r) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  for (const d of r.disks || []) {
    const pct = d.totalGB ? d.freeGB / d.totalGB : 1;
    if (pct < 0.05 || d.freeGB < 5) add('problem', `Drive ${d.drive} is almost full: ${d.freeGB} GB free of ${d.totalGB} GB. A full drive makes Windows slow and updates fail.`);
    else if (pct < 0.12) add('warning', `Drive ${d.drive} is getting full: ${d.freeGB} GB free of ${d.totalGB} GB.`);
  }
  if (r.memory?.totalGB) {
    const used = 1 - r.memory.freeGB / r.memory.totalGB;
    if (used > 0.9) add('problem', `Memory is ${Math.round(used * 100)}% used (${r.memory.freeGB} GB free of ${r.memory.totalGB} GB). The biggest users: ${(r.topMemory || []).slice(0, 3).map((p) => `${p.name} ${p.MB} MB`).join(', ')}.`);
    else if (used > 0.8) add('warning', `Memory is ${Math.round(used * 100)}% used. Biggest: ${(r.topMemory || []).slice(0, 3).map((p) => `${p.name} ${p.MB} MB`).join(', ')}.`);
  }
  if (r.cpuLoad > 85) add('warning', `The processor is busy right now (${r.cpuLoad}%).`);
  if (r.restartPending) add('problem', 'Windows is waiting for a restart to finish updates. Restarting often fixes slowness and odd problems.');
  else if (r.uptimeDays > 7) add('warning', `The PC hasn't restarted in ${r.uptimeDays} days. A restart clears out a lot of slowness.`);
  r.startupApps = (r.startupApps || []).map((n) => String(n).replace(/_[0-9A-F]{12,}$/i, ''));
  if ((r.startupApps || []).length > 8) add('warning', `${r.startupApps.length} apps start with Windows (${r.startupApps.slice(0, 6).join(', ')}…). Turning off ones you don't need makes start-up faster.`);
  if (r.tempGB > 2) add('info', `Temporary files take ${r.tempGB} GB.`);
  if (r.recycleBin?.GB > 2) add('info', `The Recycle Bin holds ${r.recycleBin.items} items (${r.recycleBin.GB} GB).`);
  if (r.internet === false) add('problem', r.wifi ? `No internet connection, although Wi-Fi "${r.wifi.network}" is connected. The router or the internet line may be down.` : 'No internet connection.');
  else if (r.dns === false) add('problem', 'The PC is online but can\'t look up website names (DNS). Restarting the router or the PC usually fixes it.');
  if (r.wifi?.signal != null && r.wifi.signal < 45) add('warning', `Wi-Fi signal is weak (${r.wifi.signal}%). Moving closer to the router helps.`);
  for (const p of r.printers || []) {
    if (p.errorJobs) add('problem', `Printer "${p.name}" has ${p.errorJobs} stuck print job${p.errorJobs > 1 ? 's' : ''}.`);
    else if (p.queued > 3) add('warning', `Printer "${p.name}" has ${p.queued} jobs waiting.`);
    if (p.default && /offline|error|paperjam|paperout|tonerlow|nottoner/i.test(p.status)) add('problem', `The main printer "${p.name}" reports: ${p.status}.`);
  }
  if (r.battery && r.battery.percent < 15 && !r.battery.charging) add('warning', `Battery is low (${r.battery.percent}%) and not charging.`);
  if (r.antivirus && r.antivirus.on === false) add('problem', 'Microsoft Defender real-time protection is off.');
  const order = { problem: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

async function checkup() {
  const r = await ps(CHECKUP, 60000);
  if (!r) throw new Error('The check-up returned nothing.');
  return { raw: r, findings: findings(r) };
}

// Recycle Bin: list items (optionally matching a name) or restore one to where it was.
const LIST_BIN = (q) => `
$sh = New-Object -ComObject Shell.Application; $rb = $sh.Namespace(10)
$q = ${JSON.stringify(String(q || '').toLowerCase())}
$out = @(); $i = 0
foreach ($it in $rb.Items()) {
  $ext = [IO.Path]::GetExtension($it.Path); $name = if (-not $ext -or $it.Name.ToLower().EndsWith($ext.ToLower())) { $it.Name } else { "$($it.Name)$ext" }  # Explorer hides extensions
  $from = $it.ExtendedProperty('System.Recycle.DeletedFrom'); $when = $it.ExtendedProperty('System.Recycle.DateDeleted')
  if (-not $q -or $name.ToLower().Contains($q)) { $out += @{ index = $i; name = $name; from = "$from"; deleted = "$when"; KB = [math]::Round($it.Size/1KB) } }
  $i++
}
@($out | Sort-Object deleted -Descending | Select-Object -First 40) | ConvertTo-Json -Depth 3 -Compress
`;
const RESTORE_BIN = (index, name) => `
$sh = New-Object -ComObject Shell.Application; $rb = $sh.Namespace(10)
$items = @($rb.Items()); $it = $items[${Number(index)}]
$ext = if ($it) { [IO.Path]::GetExtension($it.Path) } else { '' }; $full = if ($it -and (-not $ext -or $it.Name.ToLower().EndsWith($ext.ToLower()))) { $it.Name } elseif ($it) { "$($it.Name)$ext" } else { '' }
if (-not $it -or $full -ne ${JSON.stringify(String(name))}) { @{ ok = $false; error = 'That item is no longer in the Recycle Bin.' } | ConvertTo-Json -Compress; exit }
$from = "$($it.ExtendedProperty('System.Recycle.DeletedFrom'))"
$v = $it.Verbs() | Where-Object { $_.Name -replace '&','' -match '^(Restore|Wiederherstellen|Restaurer|Restaurar|Ripristina|पुनर्स्थापित)' } | Select-Object -First 1
if ($v) { $v.DoIt() } else { $it.InvokeVerb('undelete') }
Start-Sleep -Milliseconds 800
@{ ok = (Test-Path (Join-Path $from ${JSON.stringify(String(name))})); from = $from } | ConvertTo-Json -Compress
`;

const listDeleted = async (q) => {
  const r = await ps(LIST_BIN(q));
  return Array.isArray(r) ? r : r ? [r] : [];
};
const restoreDeleted = (index, name) => ps(RESTORE_BIN(index, name));

module.exports = { checkup, findings, listDeleted, restoreDeleted };
