const { execSync } = require('child_process');

const polyfill = `
function head {
  param([Parameter(ValueFromPipeline=$true)]$In, [Parameter(Position=0)]$A1, [Parameter(Position=1)]$A2, [Parameter(ValueFromRemainingArguments=$true)]$Rest)
  process {
    $c = 10; $files = @()
    @($A1, $A2) + $Rest | Where-Object { $_ } | ForEach-Object {
      if ($_ -match '^-n$') {}
      elseif ($_ -match '^-n?(\\d+)$') { $c = [int]$matches[1] }
      elseif ($_ -notmatch '^-') { $files += $_ }
    }
    if ($In) { $In | Select-Object -First $c }
    elseif ($files) { foreach ($f in $files) { Get-Content $f -TotalCount $c } }
  }
}
function wc {
  param([Parameter(ValueFromPipeline=$true)]$In, [Parameter(Position=0)]$A1, [Parameter(Position=1)]$A2, [Parameter(ValueFromRemainingArguments=$true)]$Rest)
  begin { $pipe = @() }
  process { if ($In) { $pipe += $In } }
  end {
    $l = $false; $w = $false; $c = $false; $files = @()
    @($A1, $A2) + $Rest | Where-Object { $_ } | ForEach-Object {
      if ($_ -match '^-.*l') { $l = $true }
      if ($_ -match '^-.*w') { $w = $true }
      if ($_ -match '^-.*[cm]') { $c = $true }
      if ($_ -notmatch '^-') { $files += $_ }
    }
    $all = (-not $l -and -not $w -and -not $c)
    if ($pipe) {
      $txt = $pipe -join "\`n"
      $res = @()
      if ($all -or $l) { $res += $pipe.Count }
      if ($all -or $w) { $res += ($txt -split '\\s+' | Where-Object { $_ }).Count }
      if ($all -or $c) { $res += [System.Text.Encoding]::UTF8.GetByteCount($txt) }
      Write-Output ($res -join " ")
    } elseif ($files) {
      foreach ($f in $files) {
        if (Test-Path $f) {
          $lines = (Get-Content $f).Count
          $raw = [System.IO.File]::ReadAllText((Resolve-Path $f))
          $words = ($raw -split '\\s+' | Where-Object { $_ }).Count
          $bytes = [System.Text.Encoding]::UTF8.GetByteCount($raw)
          $res = @()
          if ($all -or $l) { $res += $lines }
          if ($all -or $w) { $res += $words }
          if ($all -or $c) { $res += $bytes }
          $res += $f
          Write-Output ($res -join " ")
        }
      }
    }
  }
}
`;

const cmd = polyfill + `\n
"line 1\`nline 2\`nline 3\`nline 4\`nline 5" | head -n 3
"hello world test" | wc -w
Get-Content package.json | wc -l
`;

const out = execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd.replace(/"/g, '\\"')}"`).toString();
console.log('OUTPUT:\n' + out);

