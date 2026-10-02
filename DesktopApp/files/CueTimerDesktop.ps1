$script:logPath = Join-Path $PSScriptRoot 'CueTimerDesktop.log'

# Privacy migration: remove legacy browser-tab debug lines from an existing log.
# The ComfyUI tab finder still inspects tab titles in memory, but never persists them.
try {
    if (Test-Path $script:logPath) {
        $legacyTabLogPattern = '^(=== ComfyUI TAB SCAN |\[BROWSER\]|\[TAB \d+\]|\[MATCH\] TAB |\[PERCENT CANDIDATE\] TAB |\[FALLBACK TITLE\]|\[PERCENT FALLBACK MATCH\] TAB )'
        $lines = Get-Content -Path $script:logPath -Encoding UTF8
        $filtered = @($lines | Where-Object { $_ -notmatch $legacyTabLogPattern })
        if ($filtered.Count -ne $lines.Count) {
            Set-Content -Path $script:logPath -Encoding UTF8 -Value $filtered
        }
    }
} catch {}
trap { try { ($_ | Out-String) | Set-Content -Encoding UTF8 $script:logPath } catch {} ; exit 1 }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ErrorActionPreference = 'SilentlyContinue'

# Resolve ComfyUI base URL from the existing INI when available.
$desktopUrl = 'http://127.0.0.1:8188/slimy/cuetimer/desktop'
$iniPath = Join-Path $PSScriptRoot 'CueTimerDesktop.ini'
if (Test-Path $iniPath) {
    foreach ($line in Get-Content $iniPath) {
        if ($line -match '^\s*url\s*=\s*(.+?)\s*$') { $desktopUrl = $matches[1]; break }
    }
}
try {
    $u = [Uri]$desktopUrl
    $port = if ($u.IsDefaultPort) { '' } else { ':' + $u.Port }
    $baseUrl = $u.Scheme + '://' + $u.Host + $port
} catch {
    $baseUrl = 'http://127.0.0.1:8188'
}
$stateUrl   = $baseUrl + '/slimy/cuetimer/mirror_state'
$controlUrl = $baseUrl + '/slimy/cuetimer/mirror_control'
$previewUrl = $baseUrl + '/slimy/cuetimer/mirror_preview'

# Native hit-testing: 8 px edge/corners resize, everything else is drag-to-move.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SlimyNative {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);
}
"@

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Slimy CueTimer" Width="430" Height="520" MinWidth="160" MinHeight="190"
        WindowStyle="None" ResizeMode="CanResize" Background="#111318"
        ShowInTaskbar="True" SnapsToDevicePixels="True">
  <Border Background="#111318" BorderBrush="#2c313d" BorderThickness="1" CornerRadius="8" Padding="10">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="6"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <Button x:Name="MiniButton" Grid.Row="0" Grid.RowSpan="2" Width="30" Height="28"
              HorizontalAlignment="Right" VerticalAlignment="Top" Panel.ZIndex="20" Margin="0,0,35,0"
              ToolTip="Collapse to mini widget" Background="#20242D" Foreground="#D7DEE8" BorderBrush="#3A414E" Padding="0">
        <Grid Width="18" Height="18">
          <TextBlock x:Name="MiniButtonText" Text="−" FontSize="20" FontWeight="SemiBold" Margin="0,-3,0,0"
                     VerticalAlignment="Center" HorizontalAlignment="Center"/>
          <Grid x:Name="RestoreIcon" Width="14" Height="12" Visibility="Collapsed"
                VerticalAlignment="Center" HorizontalAlignment="Center">
            <Border BorderBrush="#D7DEE8" BorderThickness="1"/>
            <Border Height="3" Background="#D7DEE8" VerticalAlignment="Top"/>
          </Grid>
        </Grid>
      </Button>

      <Button x:Name="CloseButton" Grid.Row="0" Grid.RowSpan="2" Width="34" Height="32"
              HorizontalAlignment="Right" VerticalAlignment="Top" Panel.ZIndex="20" Margin="0,-2,-2,0"
              ToolTip="Close CueTimer widget" Background="#20242D" Foreground="#D7DEE8" BorderBrush="#3A414E" Padding="0">
        <TextBlock Text="×" FontSize="28" FontWeight="Normal" Margin="0,-4,0,0"
                   VerticalAlignment="Center" HorizontalAlignment="Center"/>
      </Button>

      <StackPanel x:Name="TimerPanel" Grid.Row="0" Orientation="Horizontal" HorizontalAlignment="Center"
                  VerticalAlignment="Center" Margin="0,0,0,5"
                  TextOptions.TextFormattingMode="Display">
        <StackPanel.Effect>
          <DropShadowEffect Color="#00FF66" BlurRadius="9" ShadowDepth="0" Opacity="0.58"/>
        </StackPanel.Effect>
        <TextBlock x:Name="TimerPart1" Text="00" Width="62" TextAlignment="Center" VerticalAlignment="Center"
                   Foreground="#00FF66" FontFamily="Orbitron, Consolas" FontSize="34" FontWeight="SemiBold"/>
        <TextBlock x:Name="TimerColon1" Text=":" Width="18" TextAlignment="Center" VerticalAlignment="Center"
                   Foreground="#00FF66" FontFamily="Orbitron, Consolas" FontSize="34" FontWeight="SemiBold"/>
        <TextBlock x:Name="TimerPart2" Text="00" Width="62" TextAlignment="Center" VerticalAlignment="Center"
                   Foreground="#00FF66" FontFamily="Orbitron, Consolas" FontSize="34" FontWeight="SemiBold"/>
        <TextBlock x:Name="TimerColon2" Text=":" Width="18" TextAlignment="Center" VerticalAlignment="Center"
                   Foreground="#00FF66" FontFamily="Orbitron, Consolas" FontSize="34" FontWeight="SemiBold"/>
        <TextBlock x:Name="TimerPart3" Text="000" Width="86" TextAlignment="Center" VerticalAlignment="Center"
                   Foreground="#00FF66" FontFamily="Orbitron, Consolas" FontSize="34" FontWeight="SemiBold"/>
      </StackPanel>

      <StackPanel x:Name="StatsPanel" Grid.Row="1" Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,0,0,6">
        <TextBlock x:Name="StepsText" Text="Steps 0 / 0" Foreground="#74DFA0" FontFamily="Orbitron, Consolas" FontSize="13"/>
        <TextBlock Text="  •  " Foreground="#4E9D6B" FontFamily="Orbitron, Consolas" FontSize="13"/>
        <TextBlock x:Name="PctText" Text="0%" Foreground="#74DFA0" FontFamily="Orbitron, Consolas" FontSize="13"/>
      </StackPanel>

      <ProgressBar x:Name="Progress" Grid.Row="2" Minimum="0" Maximum="100" Value="0" Height="6"
                   VerticalAlignment="Stretch" BorderThickness="0" Background="#18231D" Foreground="#00D95A"/>

      <StackPanel x:Name="ControlsPanel" Grid.Row="3" Orientation="Horizontal" HorizontalAlignment="Left" VerticalAlignment="Center" Margin="2,8,0,0">
        <CheckBox x:Name="TimerToggle" Content="Timer" IsChecked="True"
                  Foreground="#EEF2F7" FontSize="13" FontWeight="SemiBold" Margin="0,0,10,0" Padding="2"/>
        <CheckBox x:Name="PreviewToggle" Content="Peep" IsChecked="True"
                  Foreground="#EEF2F7" FontSize="13" FontWeight="SemiBold" Margin="0,0,10,0" Padding="2"/>
        <CheckBox x:Name="PeepSoundToggle" Content="PeepSound" IsChecked="True"
                  Foreground="#EEF2F7" FontSize="12" FontWeight="SemiBold" Margin="0,0,10,0" Padding="2"/>
        <CheckBox x:Name="TopmostToggle" Content="Always on top" IsChecked="False"
                  Foreground="#EEF2F7" FontSize="12" FontWeight="SemiBold" Padding="2"/>
      </StackPanel>

      <Border x:Name="PreviewWrap" Grid.Row="4" Background="#0B0D11" BorderBrush="#2C313D" BorderThickness="1"
              CornerRadius="8" Margin="0,6,0,8" ClipToBounds="True">
        <Grid>
          <Image x:Name="PreviewImage" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
          <MediaElement x:Name="FinalVideo" Stretch="Uniform" Visibility="Collapsed"
                        LoadedBehavior="Manual" UnloadedBehavior="Manual" ScrubbingEnabled="True"
                        IsMuted="True"/>
          <TextBlock x:Name="NoPreview" Text="Waiting for CueTimer preview…" Foreground="#687386" FontSize="13"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Grid>
      </Border>

      <Grid x:Name="BottomPanel" Grid.Row="5" Margin="0,1,0,9" Height="25">
        <TextBlock x:Name="StatusText" Text="Connecting…" Foreground="#6F7A89" FontSize="10"
                   HorizontalAlignment="Left" VerticalAlignment="Center" MaxWidth="72"
                   TextTrimming="CharacterEllipsis"/>

        <Button x:Name="ParentButton" HorizontalAlignment="Center" VerticalAlignment="Center"
                Height="23" MinWidth="76" Padding="6,0,7,0" ToolTip="Show existing ComfyUI tab"
                Background="#20242D" Foreground="#D7DEE8" BorderBrush="#3A414E">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
            <TextBlock Text="⤴️" FontFamily="Segoe UI Emoji" FontSize="15" Margin="0,-1,4,0" VerticalAlignment="Center"/>
            <TextBlock Text="ComfyUI" FontSize="9.5" FontWeight="SemiBold" VerticalAlignment="Center"/>
          </StackPanel>
        </Button>
      </Grid>
    </Grid>
  </Border>
</Window>
"@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$timerPanel = $window.FindName('TimerPanel')
$timerPart1 = $window.FindName('TimerPart1')
$timerPart2 = $window.FindName('TimerPart2')
$timerPart3 = $window.FindName('TimerPart3')
$timerColon1 = $window.FindName('TimerColon1')
$timerColon2 = $window.FindName('TimerColon2')
$statsPanel = $window.FindName('StatsPanel')
$stepsText = $window.FindName('StepsText')
$pctText = $window.FindName('PctText')
$progress = $window.FindName('Progress')
$previewWrap = $window.FindName('PreviewWrap')
$previewImage = $window.FindName('PreviewImage')
$finalVideo = $window.FindName('FinalVideo')
$noPreview = $window.FindName('NoPreview')
$statusText = $window.FindName('StatusText')
$timerToggle = $window.FindName('TimerToggle')
$previewToggle = $window.FindName('PreviewToggle')
$peepSoundToggle = $window.FindName('PeepSoundToggle')
$topmostToggle = $window.FindName('TopmostToggle')
$parentButton = $window.FindName('ParentButton')
$closeButton = $window.FindName('CloseButton')
$miniButton = $window.FindName('MiniButton')
$miniButtonText = $window.FindName('MiniButtonText')
$restoreIcon = $window.FindName('RestoreIcon')
$controlsPanel = $window.FindName('ControlsPanel')
$bottomPanel = $window.FindName('BottomPanel')

# Remove standard chrome but preserve native resize behavior.
$chrome = [System.Windows.Shell.WindowChrome]::new()
$chrome.CaptionHeight = 0
$chrome.ResizeBorderThickness = [System.Windows.Thickness]::new(8)
$chrome.GlassFrameThickness = [System.Windows.Thickness]::new(0)
$chrome.CornerRadius = [System.Windows.CornerRadius]::new(0)
$chrome.UseAeroCaptionButtons = $false
[System.Windows.Shell.WindowChrome]::SetWindowChrome($window, $chrome)

$script:lastPreviewVersion = -1
$script:lastPreviewAttempt = [DateTime]::MinValue
$script:previewBitmap = $null
$script:finalVideoKey = ''
$script:hasFinalVideo = $false
$script:previewFrames = 1
$script:previewIndex = 0
$script:endHoldTicks = 0
$script:isRunning = $false
$script:pollBusy = $false
$script:lastStatusMode = ''
$script:remoteTimerVisible = $true
$script:pendingTimerVisible = $null
$script:pendingTimerVisibleSince = [DateTime]::MinValue
$script:remotePeepVisible = $true
$script:syncingPeepSound = $false
$script:pendingPeepSound = $null
$script:pendingPeepSoundSince = [DateTime]::MinValue
$script:isMini = $false
$script:restoreWidth = 430.0
$script:restoreHeight = 520.0
$script:restoreMinWidth = 160.0
$script:restoreMinHeight = 190.0
$script:restoreLeft = [double]::NaN
$script:restoreTop = [double]::NaN

# Match the parent CueTimer behavior: timer typography follows available width.
# 430 px is the desktop widget's reference width; below that, shrink continuously.
function Update-ResponsiveTypography {
    try {
        $w = [double]$window.ActualWidth
        if ($w -le 0) { $w = [double]$window.Width }
        if ($script:isMini) {
            foreach ($tb in @($timerPart1,$timerColon1,$timerPart2,$timerColon2,$timerPart3)) { if ($tb) { $tb.FontSize = 20.0 } }
            $timerPanel.HorizontalAlignment = 'Left'
            $timerPanel.Margin = [System.Windows.Thickness]::new(4,0,0,0)
            $timerPart1.Width = 44.0
            $timerPart2.Width = 44.0
            $timerPart3.Width = 58.0
            $timerColon1.Width = 10.0
            $timerColon2.Width = 10.0
            return
        }
        $scale = [Math]::Min(1.0, [Math]::Max(0.25, $w / 430.0))
        $timerFontSize = [Math]::Max(10.0, 34.0 * $scale)
        foreach ($tb in @($timerPart1,$timerColon1,$timerPart2,$timerColon2,$timerPart3)) { if ($tb) { $tb.FontSize = $timerFontSize } }
        $timerPanel.HorizontalAlignment = 'Center'
        $timerPanel.Margin = [System.Windows.Thickness]::new(0,0,0,5)
        $timerPart1.Width = [Math]::Max(22.0, 62.0 * $scale)
        $timerPart2.Width = [Math]::Max(22.0, 62.0 * $scale)
        $timerPart3.Width = [Math]::Max(30.0, 86.0 * $scale)
        $timerColon1.Width = [Math]::Max(8.0, 18.0 * $scale)
        $timerColon2.Width = [Math]::Max(8.0, 18.0 * $scale)
        $stepsText.FontSize = [Math]::Max(8.0, 13.0 * $scale)
        $pctText.FontSize = [Math]::Max(8.0, 13.0 * $scale)
    } catch {}
}


function Set-MiniMode([bool]$enable) {
    try {
        if ($enable -eq $script:isMini) { return }

        if ($enable) {
            $script:restoreWidth = [double]$window.ActualWidth
            $script:restoreHeight = [double]$window.ActualHeight
            $script:restoreMinWidth = [double]$window.MinWidth
            $script:restoreMinHeight = [double]$window.MinHeight
            $script:restoreLeft = [double]$window.Left
            $script:restoreTop = [double]$window.Top

            $script:isMini = $true
            $statsPanel.Visibility = 'Collapsed'
            $progress.Visibility = 'Collapsed'
            $controlsPanel.Visibility = 'Collapsed'
            $previewWrap.Visibility = 'Collapsed'
            $bottomPanel.Visibility = 'Collapsed'
            $closeButton.Visibility = 'Visible'

            $window.ResizeMode = 'NoResize'
            $window.MinWidth = 275
            $window.MinHeight = 76
            $window.Width = 275
            $window.Height = 76
            if (-not [double]::IsNaN($script:restoreLeft)) { $window.Left = $script:restoreLeft }
            if (-not [double]::IsNaN($script:restoreTop)) { $window.Top = $script:restoreTop }

            $miniButton.Width = 30
            $miniButton.Height = 28
            $miniButton.Margin = [System.Windows.Thickness]::new(0,0,35,0)
            $miniButton.ToolTip = 'Restore CueTimer widget'
            $miniButtonText.Visibility = 'Collapsed'
            if ($restoreIcon) { $restoreIcon.Visibility = 'Visible' }
            Update-ResponsiveTypography
        } else {
            $script:isMini = $false

            $window.ResizeMode = 'CanResize'
            $window.MinWidth = $script:restoreMinWidth
            $window.MinHeight = $script:restoreMinHeight
            $window.Width = $script:restoreWidth
            $window.Height = $script:restoreHeight
            if (-not [double]::IsNaN($script:restoreLeft)) { $window.Left = $script:restoreLeft }
            if (-not [double]::IsNaN($script:restoreTop)) { $window.Top = $script:restoreTop }

            $controlsPanel.Visibility = 'Visible'
            Update-TimerVisibility
            Update-PreviewVisibility
            $bottomPanel.Visibility = 'Visible'
            $closeButton.Visibility = 'Visible'

            $miniButton.Width = 30
            $miniButton.Height = 28
            $miniButton.Margin = [System.Windows.Thickness]::new(0,0,35,0)
            $miniButton.ToolTip = 'Collapse to mini widget'
            if ($restoreIcon) { $restoreIcon.Visibility = 'Collapsed' }
            $miniButtonText.Visibility = 'Visible'
            $miniButtonText.Text = '−'
            $miniButtonText.FontSize = 20
            Update-ResponsiveTypography
        }
    } catch {
        try { ('Mini mode failed: ' + $_.Exception.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
    }
}

function Update-StatusText([string]$mode = '') {
    if ($mode) { $script:lastStatusMode = $mode } else { $mode = $script:lastStatusMode }
    switch ($mode) {
        'disconnected' { $statusText.Text = 'ComfyUI disconnected' }
        'preview_error' { $statusText.Text = 'PreviewError' }
        default {
            if ($script:isRunning) {
                if ($null -eq $script:previewBitmap) { $statusText.Text = 'Peeping...' }
                else { $statusText.Text = 'Running' }
            } else {
                $statusText.Text = 'Ready'
            }
        }
    }
}

function Update-TimerVisibility {
    $localOn = $true
    if ($timerToggle -and $null -ne $timerToggle.IsChecked) { $localOn = [bool]$timerToggle.IsChecked }
    $showTimer = $localOn -and $script:remoteTimerVisible

    $timerPanel.Visibility = if ($showTimer) { 'Visible' } else { 'Collapsed' }
    if ($script:isMini) {
        $statsPanel.Visibility = 'Collapsed'
        $progress.Visibility = 'Collapsed'
    } else {
        $statsPanel.Visibility = if ($showTimer) { 'Visible' } else { 'Collapsed' }
        $progress.Visibility = if ($showTimer) { 'Visible' } else { 'Collapsed' }
    }
}

function Update-PreviewVisibility {
    $localOn = $true
    if ($previewToggle -and $null -ne $previewToggle.IsChecked) { $localOn = [bool]$previewToggle.IsChecked }
    $previewWrap.Visibility = if ((-not $script:isMini) -and $localOn -and $script:remotePeepVisible) { 'Visible' } else { 'Collapsed' }
}

function Test-ComfyUITabName([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return $false }
    $n = $name.Trim()

    # Normal / idle ComfyUI title. Chrome may append extra tab metadata after this.
    if ($n.IndexOf(' - ComfyUI', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }

    # Running ComfyUI title, e.g. [10%][2 ノードが実行中] - メモリ使用量 - 584 MB
    if ($n -match '^\[\d+%\]\[\d+\s+ノードが実行中\]') { return $true }

    return $false
}

function Test-PercentFallbackTabName([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return $false }
    # Last-resort fallback only: any tab whose trimmed title begins with [<number>%].
    return ($name.Trim() -match '^\[\d+%\]')
}

function Focus-ComfyUITab {
    try {
        $names = @('msedge','chrome','brave')
        $percentFallback = $null

        foreach ($proc in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName -and $_.MainWindowHandle -ne 0 })) {
            try {
                $hwnd = [IntPtr]$proc.MainWindowHandle
                $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
                if ($null -eq $root) { continue }

                $cond = [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::TabItem
                )
                $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
                for ($i = 0; $i -lt $tabs.Count; $i++) {
                    $tab = $tabs.Item($i)
                    $name = [string]$tab.Current.Name

                    # Existing ComfyUI rules always win. Tab titles are inspected only in memory and never logged.
                    if (Test-ComfyUITabName $name) {
                        $pat = $null
                        if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
                            ([System.Windows.Automation.SelectionItemPattern]$pat).Select()
                        }
                        if ([SlimyNative]::IsIconic($hwnd)) { [SlimyNative]::ShowWindowAsync($hwnd, 9) | Out-Null }
                        Start-Sleep -Milliseconds 50
                        [SlimyNative]::SetForegroundWindow($hwnd) | Out-Null
                        $statusText.Text = 'ComfyUI'
                        return $true
                    }

                    # Remember only the first [*%] candidate. Do not retain its title.
                    if ($null -eq $percentFallback -and (Test-PercentFallbackTabName $name)) {
                        $percentFallback = [PSCustomObject]@{ Tab = $tab; Hwnd = $hwnd }
                    }
                }

                # Existing safe fallback remains higher priority than [*%]. Window title is not logged.
                $title = [string]$proc.MainWindowTitle
                if (Test-ComfyUITabName $title) {
                    if ([SlimyNative]::IsIconic($hwnd)) { [SlimyNative]::ShowWindowAsync($hwnd, 9) | Out-Null }
                    [SlimyNative]::SetForegroundWindow($hwnd) | Out-Null
                    $statusText.Text = 'ComfyUI'
                    return $true
                }
            } catch {}
        }

        # Only after every existing rule failed, use a tab beginning with [<number>%].
        if ($null -ne $percentFallback) {
            try {
                $pat = $null
                if ($percentFallback.Tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
                    ([System.Windows.Automation.SelectionItemPattern]$pat).Select()
                }
                if ([SlimyNative]::IsIconic($percentFallback.Hwnd)) { [SlimyNative]::ShowWindowAsync($percentFallback.Hwnd, 9) | Out-Null }
                Start-Sleep -Milliseconds 50
                [SlimyNative]::SetForegroundWindow($percentFallback.Hwnd) | Out-Null
                $statusText.Text = 'ComfyUI'
                return $true
            } catch {}
        }

        try { Add-Content -Path $script:logPath -Encoding UTF8 -Value '[RESULT] ComfyUI tab not found' } catch {}
        $statusText.Text = 'ComfyUI tab not found'
        return $false
    } catch {
        $statusText.Text = 'ComfyUI tab not found'
        return $false
    }
}

function Set-PeepSoundState([bool]$enabled) {
    try {
        $body = @{ peep_sound = $enabled } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $controlUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2 | Out-Null
        $script:pendingPeepSound = $enabled
        $script:pendingPeepSoundSince = [DateTime]::UtcNow
    } catch {
        Add-Content -Path $script:logPath -Value ((Get-Date -Format o) + ' PeepSound POST: ' + $_.Exception.Message) -Encoding UTF8
    }
}

function Set-TimerVisibleState([bool]$enabled) {
    try {
        $body = @{ timer_visible = $enabled } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $controlUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2 | Out-Null
        $script:pendingTimerVisible = $enabled
        $script:pendingTimerVisibleSince = [DateTime]::UtcNow
    } catch {
        Add-Content -Path $script:logPath -Value ((Get-Date -Format o) + ' Timer POST: ' + $_.Exception.Message) -Encoding UTF8
    }
}


function Clear-FinalVideo {
    if (-not $finalVideo) { return }
    try { $finalVideo.Stop() } catch {}
    try { $finalVideo.Source = $null } catch {}
    $finalVideo.Visibility = 'Collapsed'
    $script:finalVideoKey = ''
    $script:hasFinalVideo = $false
}

function Set-FinalVideo($asset) {
    if (-not $finalVideo -or $null -eq $asset -or [string]::IsNullOrWhiteSpace([string]$asset.filename)) { return }
    try {
        $filename = [System.Uri]::EscapeDataString([string]$asset.filename)
        $subfolder = [System.Uri]::EscapeDataString([string]$(if ($null -ne $asset.subfolder) { $asset.subfolder } else { '' }))
        $type = [System.Uri]::EscapeDataString([string]$(if ($null -ne $asset.type -and -not [string]::IsNullOrWhiteSpace([string]$asset.type)) { $asset.type } else { 'output' }))
        $url = $baseUrl + '/view?filename=' + $filename + '&subfolder=' + $subfolder + '&type=' + $type
        $key = $url
        if ($script:hasFinalVideo -and $script:finalVideoKey -eq $key) { return }

        try { $finalVideo.Stop() } catch {}
        $finalVideo.Source = [Uri]$url
        $finalVideo.Visibility = 'Visible'
        $previewImage.Source = $null
        $noPreview.Visibility = 'Collapsed'
        $script:finalVideoKey = $key
        $script:hasFinalVideo = $true
        $finalVideo.Position = [TimeSpan]::Zero
        $finalVideo.Play()
    } catch {
        try { ('Final video load failed: ' + $_.Exception.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
    }
}

function Get-JsonState {
    $req = [System.Net.HttpWebRequest]::Create($stateUrl)
    $req.Method = 'GET'
    $req.Timeout = 350
    $req.ReadWriteTimeout = 350
    $req.KeepAlive = $true
    $req.CachePolicy = [System.Net.Cache.RequestCachePolicy]::new([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
    $resp = $req.GetResponse()
    try {
        $sr = [IO.StreamReader]::new($resp.GetResponseStream())
        try { return ($sr.ReadToEnd() | ConvertFrom-Json) } finally { $sr.Dispose() }
    } finally { $resp.Dispose() }
}

function Load-Preview([int]$version) {
    $wc = $null
    $mem = $null
    try {
        $wc = [System.Net.WebClient]::new()
        $wc.Headers['Cache-Control'] = 'no-cache'
        $bytes = $wc.DownloadData($previewUrl + '?v=' + $version + '&t=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        if ($null -eq $bytes -or $bytes.Length -le 0) { return 'waiting' }

        $mem = [System.IO.MemoryStream]::new([byte[]]$bytes, $false)
        $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
            $mem,
            [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
            [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        )
        if ($decoder.Frames.Count -lt 1) { return 'waiting' }
        $bmp = $decoder.Frames[0]
        $bmp.Freeze()

        $script:previewBitmap = $bmp
        $script:previewIndex = 0
        $script:endHoldTicks = 0
        $noPreview.Visibility = 'Collapsed'
        Show-PreviewFrame
        Update-StatusText 'normal'
        return 'ok'
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        $code = if ($resp -and $resp -is [System.Net.HttpWebResponse]) { [int]$resp.StatusCode } else { 0 }
        if ($code -eq 404) {
            Update-StatusText 'normal'
            return 'waiting'
        }
        $msg = $_.Exception.Message
        try { ('Preview v{0} load failed: {1}' -f $version, $msg) | Add-Content -Encoding UTF8 $script:logPath } catch {}
        Update-StatusText 'preview_error'
        return 'error'
    } catch {
        $msg = $_.Exception.Message
        try { ('Preview v{0} load failed: {1}' -f $version, $msg) | Add-Content -Encoding UTF8 $script:logPath } catch {}
        Update-StatusText 'preview_error'
        return 'error'
    } finally {
        if ($mem) { $mem.Dispose() }
        if ($wc) { $wc.Dispose() }
    }
}

function Show-PreviewFrame {
    if ($script:hasFinalVideo) { return }
    if ($null -eq $script:previewBitmap) { return }
    $count = [Math]::Max(1, [int]$script:previewFrames)
    if ($count -le 1) {
        $previewImage.Source = $script:previewBitmap
        return
    }
    $fullW = $script:previewBitmap.PixelWidth
    $fullH = $script:previewBitmap.PixelHeight
    $frameW = [Math]::Max(1, [int][Math]::Floor($fullW / $count))
    $idx = [Math]::Min($count - 1, [Math]::Max(0, [int]$script:previewIndex))
    $x = $idx * $frameW
    $w = if ($idx -eq $count - 1) { [Math]::Max(1, $fullW - $x) } else { $frameW }
    try {
        $crop = [System.Windows.Media.Imaging.CroppedBitmap]::new($script:previewBitmap, [System.Windows.Int32Rect]::new($x, 0, $w, $fullH))
        $crop.Freeze()
        $previewImage.Source = $crop
    } catch {
        $previewImage.Source = $script:previewBitmap
    }
}


if ($finalVideo) {
    $finalVideo.Add_MediaEnded({
        try {
            $finalVideo.Position = [TimeSpan]::Zero
            $finalVideo.Play()
        } catch {}
    })
    $finalVideo.Add_MediaFailed({
        param($sender, $e)
        try { ('Final video media failed: ' + $e.ErrorException.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
    })
}

$flipTimer = [System.Windows.Threading.DispatcherTimer]::new()
$flipTimer.Interval = [TimeSpan]::FromMilliseconds(240)
$flipTimer.Add_Tick({
    if ($script:hasFinalVideo -or !$script:isRunning -or $null -eq $script:previewBitmap -or $script:previewFrames -le 1) { return }
    $last = $script:previewFrames - 1
    if ($script:previewIndex -ge $last) {
        $script:endHoldTicks++
        if ($script:endHoldTicks -ge 5) {
            $script:previewIndex = 0
            $script:endHoldTicks = 0
        }
    } else {
        $script:previewIndex++
        $script:endHoldTicks = 0
    }
    Show-PreviewFrame
})
$flipTimer.Start()

if ($timerToggle) {
    $timerToggle.Add_Click({
        if ($null -ne $timerToggle.IsChecked) {
            $enabled = [bool]$timerToggle.IsChecked
            Set-TimerVisibleState $enabled
            $script:remoteTimerVisible = $enabled
            Update-TimerVisibility
        }
    })
}
if ($previewToggle) {
    $previewToggle.Add_Click({ Update-PreviewVisibility })
}
if ($peepSoundToggle) {
    $peepSoundToggle.Add_Click({
        if (!$script:syncingPeepSound) {
            Set-PeepSoundState ([bool]$peepSoundToggle.IsChecked)
        }
    })
}
if ($topmostToggle) {
    $topmostToggle.Add_Click({ $window.Topmost = [bool]$topmostToggle.IsChecked })
}
Update-TimerVisibility
Update-PreviewVisibility
Update-StatusText 'normal'

if ($parentButton) {
    $parentButton.Add_Click({ [void](Focus-ComfyUITab) })
}
if ($closeButton) {
    $closeButton.Add_Click({ $window.Close() })
}
if ($miniButton) {
    $miniButton.Add_Click({ Set-MiniMode (-not $script:isMini) })
}

$window.Add_SourceInitialized({
    try {
        $hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($window)).Handle
        if ($hwnd -ne [IntPtr]::Zero) {
            $preference = 2  # DWMWCP_ROUND
            [void][SlimyNative]::DwmSetWindowAttribute($hwnd, 33, [ref]$preference, 4)  # DWMWA_WINDOW_CORNER_PREFERENCE
        }
    } catch {}
})

$window.Add_SizeChanged({ Update-ResponsiveTypography })
$window.Add_Loaded({ Update-ResponsiveTypography })

$pollTimer = [System.Windows.Threading.DispatcherTimer]::new()
$pollTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$pollTimer.Add_Tick({
    if ($script:pollBusy) { return }
    $script:pollBusy = $true
    try {
        $s = Get-JsonState
        $script:isRunning = [bool]$s.running
        Update-StatusText 'normal'
        $timerValue = if ($s.timer) { [string]$s.timer } else { '00:00:000' }
        $timerParts = $timerValue -split ':', 3
        $timerPart1.Text = if ($timerParts.Count -ge 1 -and $timerParts[0] -ne '') { $timerParts[0] } else { '00' }
        $timerPart2.Text = if ($timerParts.Count -ge 2 -and $timerParts[1] -ne '') { $timerParts[1] } else { '00' }
        $timerPart3.Text = if ($timerParts.Count -ge 3 -and $timerParts[2] -ne '') { $timerParts[2] } else { '000' }
        $stepsText.Text = 'Steps {0} / {1}' -f ([int]$s.step), ([int]$s.step_total)
        $p = [Math]::Max(0, [Math]::Min(100, [double]$s.total_pct))
        $pctText.Text = ('{0:0}%' -f $p)
        $progress.Value = $p

        $remoteTimerVisible = ($s.timer_visible -ne $false)
        if ($null -ne $script:pendingTimerVisible) {
            if ($remoteTimerVisible -eq [bool]$script:pendingTimerVisible) {
                $script:pendingTimerVisible = $null
            } elseif (([DateTime]::UtcNow - $script:pendingTimerVisibleSince).TotalSeconds -lt 3.0) {
                $remoteTimerVisible = [bool]$script:pendingTimerVisible
            } else {
                $script:pendingTimerVisible = $null
            }
        }
        $script:remoteTimerVisible = $remoteTimerVisible
        if ($timerToggle -and ([bool]$timerToggle.IsChecked -ne $remoteTimerVisible)) {
            $timerToggle.IsChecked = $remoteTimerVisible
        }
        Update-TimerVisibility
        $script:remotePeepVisible = ($s.peep_visible -ne $false)
        Update-PreviewVisibility
        if ($peepSoundToggle -and $null -ne $s.peep_sound) {
            $remotePeepSound = ($s.peep_sound -ne $false)
            if ($null -ne $script:pendingPeepSound) {
                if ($remotePeepSound -eq [bool]$script:pendingPeepSound) {
                    $script:pendingPeepSound = $null
                } elseif (([DateTime]::UtcNow - $script:pendingPeepSoundSince).TotalSeconds -lt 3.0) {
                    # Wait for the parent node to consume the one-shot command.
                    $remotePeepSound = [bool]$script:pendingPeepSound
                } else {
                    $script:pendingPeepSound = $null
                }
            }
            if ([bool]$peepSoundToggle.IsChecked -ne $remotePeepSound) {
                $script:syncingPeepSound = $true
                try { $peepSoundToggle.IsChecked = $remotePeepSound } finally { $script:syncingPeepSound = $false }
            }
        }

        if ($null -ne $s.final_video -and -not [string]::IsNullOrWhiteSpace([string]$s.final_video.filename)) {
            Set-FinalVideo $s.final_video
        } elseif ($script:hasFinalVideo) {
            # Queue start clears final_video in the parent mirror state.
            Clear-FinalVideo
            if ($null -ne $script:previewBitmap) { Show-PreviewFrame }
            else { $noPreview.Visibility = 'Visible' }
        }

        $script:previewFrames = [Math]::Max(1, [int]$s.preview_frames)
        $ver = [int]$s.preview_version
        if ($ver -le 0) {
            $script:lastPreviewVersion = $ver
            $script:previewBitmap = $null
            $previewImage.Source = $null
            $noPreview.Visibility = 'Visible'
            Update-StatusText 'normal'
        } elseif ($ver -ne $script:lastPreviewVersion) {
            # Retry the same version after a transient HTTP/decode failure.
            $now = [DateTime]::UtcNow
            if (($now - $script:lastPreviewAttempt).TotalMilliseconds -ge 700) {
                $script:lastPreviewAttempt = $now
                $loadResult = Load-Preview $ver
                if ($loadResult -eq 'ok') {
                    $script:lastPreviewVersion = $ver
                } elseif ($loadResult -eq 'waiting') {
                    # A new preview version with no image means the queue-start clear
                    # has arrived. Drop the previous queue's bitmap immediately while
                    # continuing to retry this version until a new preview is posted.
                    $script:previewBitmap = $null
                    $script:previewIndex = 0
                    $script:endHoldTicks = 0
                    $previewImage.Source = $null
                    $noPreview.Visibility = 'Visible'
                    Update-StatusText 'normal'
                }
            }
        }
    } catch {
        # A short mirror-state timeout is expected while ComfyUI is busy generating.
        # Keep the last good state and do not treat that as an error/disconnect.
        $isExpectedTimeout = $false
        $ex = $_.Exception
        while ($null -ne $ex) {
            if ($ex -is [System.Net.WebException]) {
                if ($ex.Status -eq [System.Net.WebExceptionStatus]::Timeout) {
                    $isExpectedTimeout = $true
                    break
                }
            }
            $ex = $ex.InnerException
        }
        if (-not $isExpectedTimeout) {
            $msg = [string]$_.Exception.Message
            if ($msg -match '(?i)timeout|timed out|タイムアウト') {
                $isExpectedTimeout = $true
            }
        }

        if (-not $isExpectedTimeout) {
            Update-StatusText 'disconnected'
            try { ('State poll failed: ' + $_.Exception.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
        }
    } finally {
        $script:pollBusy = $false
    }
})
$pollTimer.Start()


# Reliable drag fallback. PreviewMouse catches the press before Image/TextBlock children.
# Keep an 8 px band untouched so WindowChrome/native hit-testing can resize edges/corners.
$window.Add_PreviewMouseLeftButtonDown({
    param($sender, $e)
    try {
        if ($e.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) { return }

        $src = $e.OriginalSource

        # Preview area keeps normal drag behavior. Only a completed double-click
        # switches to the existing mini mode.
        $cur = $src
        $inPreview = $false
        while ($null -ne $cur) {
            if ($cur -eq $previewWrap) { $inPreview = $true; break }
            try { $cur = [System.Windows.Media.VisualTreeHelper]::GetParent($cur) } catch { break }
        }
        if ($inPreview -and $e.ClickCount -ge 2) {
            $e.Handled = $true
            Set-MiniMode $true
            return
        }

        # Interactive controls must remain clickable, not become drag surfaces.
        $cur = $src
        while ($null -ne $cur) {
            if ($cur -eq $timerToggle -or $cur -eq $previewToggle -or $cur -eq $peepSoundToggle -or $cur -eq $topmostToggle -or $cur -eq $parentButton -or $cur -eq $closeButton -or $cur -eq $miniButton) { return }
            try { $cur = [System.Windows.Media.VisualTreeHelper]::GetParent($cur) } catch { break }
        }

        $p = $e.GetPosition($window)
        $b = 8.0
        if ($p.X -gt $b -and $p.X -lt ($window.ActualWidth - $b) -and
            $p.Y -gt $b -and $p.Y -lt ($window.ActualHeight - $b)) {
            $e.Handled = $true
            $window.DragMove()
        }
    } catch {}
})

$window.Add_SourceInitialized({
    $helper = [System.Windows.Interop.WindowInteropHelper]::new($window)
    $hwnd = $helper.Handle
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
    $hook = [System.Windows.Interop.HwndSourceHook]{
        param($hWnd, $msg, $wParam, $lParam, [ref]$handled)
        if ($msg -ne 0x0084) { return [IntPtr]::Zero }
        $rect = [SlimyNative+RECT]::new()
        [SlimyNative]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
        $raw = $lParam.ToInt64()
        $x = [int]($raw -band 0xFFFF)
        $y = [int](($raw -shr 16) -band 0xFFFF)
        if ($x -ge 32768) { $x -= 65536 }
        if ($y -ge 32768) { $y -= 65536 }
        $b = 8
        $left = $x -lt ($rect.Left + $b)
        $right = $x -ge ($rect.Right - $b)
        $top = $y -lt ($rect.Top + $b)
        $bottom = $y -ge ($rect.Bottom - $b)
        $hit = 1 # HTCLIENT: WPF handles interior dragging so controls stay clickable
        if ($top -and $left) { $hit = 13 }
        elseif ($top -and $right) { $hit = 14 }
        elseif ($bottom -and $left) { $hit = 16 }
        elseif ($bottom -and $right) { $hit = 17 }
        elseif ($left) { $hit = 10 }
        elseif ($right) { $hit = 11 }
        elseif ($top) { $hit = 12 }
        elseif ($bottom) { $hit = 15 }
        $handled.Value = $true
        return [IntPtr]$hit
    }
    $source.AddHook($hook)
    $script:windowHook = $hook
})

$window.Add_Closed({
    $pollTimer.Stop(); $flipTimer.Stop(); Clear-FinalVideo
})

[void]$window.ShowDialog()
