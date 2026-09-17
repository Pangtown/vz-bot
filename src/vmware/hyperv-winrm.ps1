$ErrorActionPreference = 'Stop'
$action = $env:VZBOT_HV_ACTION
if (-not $action) { $action = 'test' }

try {
  $th = (Get-Item WSMan:\localhost\Client\TrustedHosts -ErrorAction SilentlyContinue).Value
  if (-not $th -or ($th -ne '*' -and $th -notlike ('*' + $env:VZBOT_HV_HOST + '*'))) {
    try {
      Set-Item WSMan:\localhost\Client\TrustedHosts -Value $env:VZBOT_HV_HOST -Concatenate -Force -ErrorAction Stop
    } catch {}
  }

  $secure = ConvertTo-SecureString $env:VZBOT_HV_PASS -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential($env:VZBOT_HV_USER, $secure)
  $splat = @{
    ComputerName   = $env:VZBOT_HV_HOST
    Port           = [int]$env:VZBOT_HV_PORT
    Credential     = $cred
    Authentication = 'Negotiate'
    ErrorAction    = 'Stop'
  }
  if ($env:VZBOT_HV_SSL -eq '1') { $splat['UseSSL'] = $true }

  if ($action -eq 'test') {
    $null = Test-WSMan @splat
    Write-Output 'VZBOT_HV_OK'
    exit 0
  }

  $json = Invoke-Command @splat -ScriptBlock {
    Import-Module Hyper-V -ErrorAction Stop
    $items = @(Get-VM | ForEach-Object {
      $vm = $_
      $disks = @(Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue | ForEach-Object {
        $capacityGb = 1
        if ($_.Path) {
          try {
            $vhd = Get-VHD -Path $_.Path -ErrorAction Stop
            $capacityGb = [int][Math]::Max(1, [Math]::Round($vhd.Size / 1GB))
          } catch {
            $capacityGb = 1
          }
        }
        [pscustomobject]@{
          label           = $_.Name
          capacityGb      = $capacityGb
          thinProvisioned = $true
          backingFileName = $_.Path
        }
      })
      if (-not $disks.Count) {
        $disks = @([pscustomobject]@{
          label           = 'Hard disk 1'
          capacityGb      = 20
          thinProvisioned = $true
          backingFileName = ''
        })
      }
      $nics = @(Get-VMNetworkAdapter -VM $vm -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{
          label       = $_.Name
          macAddress  = $_.MacAddress
          networkName = $_.SwitchName
        }
      })
      $ramBytes = 0
      if ($vm.MemoryAssigned -gt 0) { $ramBytes = [int64]$vm.MemoryAssigned }
      elseif ($vm.MemoryStartup -gt 0) { $ramBytes = [int64]$vm.MemoryStartup }
      $ramMb = [int][Math]::Max(32, [Math]::Round($ramBytes / 1MB))
      $guest = ''
      try {
        $safe = $vm.Name.Replace("'", "''")
        $vmCim = Get-CimInstance -Namespace root\virtualization\v2 -Query "SELECT * FROM Msvm_ComputerSystem WHERE ElementName='$safe'" -ErrorAction SilentlyContinue
        if ($vmCim) {
          $kvp = Get-CimAssociatedInstance -InputObject $vmCim -ResultClassName Msvm_KvpExchangeComponent -ErrorAction SilentlyContinue | Select-Object -First 1
          foreach ($blob in @($kvp.GuestIntrinsicExchangeItems)) {
            if ($blob -match '(?s)OSName</VALUE></PROPERTY>\s*<PROPERTY NAME="Data"><VALUE>([^<]*)</VALUE>') {
              $guest = $Matches[1]
              break
            }
          }
        }
      } catch {}
      $vcpus = [int]$vm.ProcessorCount
      $state = [string]$vm.State
      $power = if ($state -eq 'Running') { 'poweredOn' } else { 'poweredOff' }
      $ramStr = if ($ramMb -ge 1024) { ('{0} GB RAM' -f [int][Math]::Round($ramMb / 1024)) } else { ('{0} MB RAM' -f $ramMb) }
      $cpuLabel = if ($vcpus -gt 1) { 's' } else { '' }
      [pscustomobject]@{
        id         = ([string]$vm.Id).Trim('{}')
        name       = $vm.Name
        powerState = $power
        vcpus      = $vcpus
        ramMb      = $ramMb
        spec       = ('{0} vCPU{1} / {2}' -f $vcpus, $cpuLabel, $ramStr)
        disksCount = @($disks).Count
        disks      = @($disks)
        networks   = @($nics)
        guestOs    = $(if ($guest) { $guest } else { 'Hyper-V guest' })
        firmware   = $(if ([int]$vm.Generation -ge 2) { 'uefi' } else { 'bios' })
        guestId    = $(if ($guest -match 'win') { 'windowsGuest' } else { '' })
      }
    })
    ([pscustomobject]@{ vms = @($items) } | ConvertTo-Json -Compress -Depth 8)
  }

  Write-Output 'VZBOT_HV_VMS_BEGIN'
  Write-Output $json
  Write-Output 'VZBOT_HV_VMS_END'
} catch {
  Write-Output ('VZBOT_HV_FAIL ' + $_.Exception.Message)
  exit 1
}
