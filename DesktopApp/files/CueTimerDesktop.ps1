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
# Shown as the status-text tooltip and logged at startup, so it is always clear
# WHICH script file the exe actually ran (it runs DesktopApp\files\CueTimerDesktop.ps1).
$script:buildTag = 'CueTimerDesktop.ps1 2026-10-30 history+anchor'
trap { try { ($_ | Out-String) | Set-Content -Encoding UTF8 $script:logPath } catch {} ; exit 1 }

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms   # Screen.FromHandle: work area of the widget's monitor

$ErrorActionPreference = 'SilentlyContinue'

# Resolve ComfyUI base URL (and optional settings) from the INI when available.
#   url          = http://127.0.0.1:8188/slimy/cuetimer/desktop
#   history_rows = 3      (0 hides the history list, max 10)
$desktopUrl = 'http://127.0.0.1:8188/slimy/cuetimer/desktop'
$script:historyRows = 3
$iniPath = Join-Path $PSScriptRoot 'CueTimerDesktop.ini'
if (Test-Path $iniPath) {
    foreach ($line in Get-Content $iniPath) {
        if ($line -match '^\s*url\s*=\s*(.+?)\s*$') { $desktopUrl = $matches[1] }
        elseif ($line -match '^\s*history_rows\s*=\s*(\d+)\s*$') {
            $script:historyRows = [Math]::Min(10, [Math]::Max(0, [int]$matches[1]))
        }
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
    [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
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
        <RowDefinition Height="Auto" MinHeight="32"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="6"/>
        <RowDefinition Height="Auto"/>
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

      <Viewbox x:Name="TimerBox" Grid.Row="0" Stretch="Uniform" StretchDirection="DownOnly"
               HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,0,0,5">
      <StackPanel x:Name="TimerPanel" Orientation="Horizontal"
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
      </Viewbox>

      <Viewbox x:Name="StatsBox" Grid.Row="1" Stretch="Uniform" StretchDirection="DownOnly"
               HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,0,0,6">
      <Grid>
        <StackPanel x:Name="StatsPanel" Orientation="Horizontal">
          <TextBlock x:Name="StepsText" Text="Steps 0 / 0" Foreground="#74DFA0" FontFamily="Orbitron, Consolas" FontSize="13"/>
          <TextBlock Text="  •  " Foreground="#4E9D6B" FontFamily="Orbitron, Consolas" FontSize="13"/>
          <TextBlock x:Name="PctText" Text="0%" Foreground="#74DFA0" FontFamily="Orbitron, Consolas" FontSize="13"/>
        </StackPanel>
        <TextBlock x:Name="ResultMetrics" Visibility="Collapsed" Foreground="#74DFA0"
                   FontFamily="Orbitron, Consolas" FontSize="13" TextAlignment="Center"/>
      </Grid>
      </Viewbox>

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

      <!-- Recent renders: time / frames / steps / size, newest first (rows built in code). -->
      <Border x:Name="HistoryWrap" Grid.Row="4" Visibility="Collapsed" Margin="2,7,2,0" Padding="0,4,0,0"
              BorderBrush="#232833" BorderThickness="0,1,0,0">
        <StackPanel x:Name="HistoryPanel"/>
      </Border>

      <Border x:Name="PreviewWrap" Grid.Row="5" Background="#0B0D11" BorderBrush="#2C313D" BorderThickness="1"
              CornerRadius="8" Margin="0,6,0,8" ClipToBounds="True">
        <Grid>
          <Image x:Name="PreviewImage" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
          <MediaElement x:Name="FinalVideo" Stretch="Uniform" Visibility="Collapsed"
                        LoadedBehavior="Manual" UnloadedBehavior="Manual" ScrubbingEnabled="False"
                        IsMuted="True"/>
          <TextBlock x:Name="NoPreview" Text="Waiting for CueTimer preview…" Foreground="#687386" FontSize="13"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
          <Border x:Name="PauseBadge" Visibility="Collapsed" IsHitTestVisible="False"
                  HorizontalAlignment="Center" VerticalAlignment="Center"
                  Width="54" Height="54" CornerRadius="27" Background="#99000000">
            <TextBlock Text="❚❚" Foreground="#E6EAF0" FontSize="20" FontWeight="Bold"
                       HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-2,0,0"/>
          </Border>
        </Grid>
      </Border>

      <Grid x:Name="BottomPanel" Grid.Row="6" Margin="0,1,0,9" Height="25">
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
$timerBox = $window.FindName('TimerBox')
$statsBox = $window.FindName('StatsBox')
$resultMetrics = $window.FindName('ResultMetrics')
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
$pauseBadge = $window.FindName('PauseBadge')
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
$historyWrap = $window.FindName('HistoryWrap')
$historyPanel = $window.FindName('HistoryPanel')
try { $statusText.ToolTip = $script:buildTag + "`n" + $PSCommandPath } catch {}
try { ('{0} started {1} from {2}' -f (Get-Date -Format o), $script:buildTag, $PSCommandPath) | Add-Content -Encoding UTF8 $script:logPath } catch {}

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
$script:historySig = $null
$script:historyRowsUi = [System.Collections.Generic.List[object]]::new()
# Final video playback: the user's click choice, and what the MediaElement is doing now.
$script:userPaused = $false
$script:videoPlaying = $false
$script:clickToggledAt = [DateTime]::MinValue
# Own double-click detection for the non-preview area (DragMove() swallows ClickCount).
$script:lastBlankClickAt = [DateTime]::MinValue
$script:lastBlankClickX = 0.0
$script:lastBlankClickY = 0.0
# Poll intervals: normal vs. minimized (nothing visible, only keep state roughly fresh).
$script:pollActiveMs = 250
$script:pollIdleMs = 2000

# Timer digit sizes for a given scale. $tight lowers the minimum sizes so the
# timer can keep shrinking when the window is very narrow.
function Get-TimerMetrics([double]$sc, [bool]$tight) {
    $fMin  = if ($tight) { 7.0 }  else { 10.0 }
    $pMin  = if ($tight) { 12.0 } else { 22.0 }
    $p3Min = if ($tight) { 17.0 } else { 30.0 }
    $cMin  = if ($tight) { 4.0 }  else { 8.0 }
    $font  = [Math]::Max($fMin, 34.0 * $sc)
    $part  = [Math]::Max($pMin, 62.0 * $sc)
    $part3 = [Math]::Max($p3Min, 86.0 * $sc)
    $colon = [Math]::Max($cMin, 18.0 * $sc)
    return [PSCustomObject]@{
        Font = $font; Part = $part; Part3 = $part3; Colon = $colon
        Total = (2.0 * $part + $part3 + 2.0 * $colon)
    }
}

# ── Top rows layout (normal size) ─────────────────────────────────────────────
# Everything here is MEASURED from the live elements instead of predicted from
# hard-coded sizes, so fonts / DPI / glyph widths can't make the rows run under
# the top-right buttons. Each row sits in a DownOnly Viewbox: it stays centered
# while there is room, slides left as the window narrows, and is scaled down as a
# whole (real rendered size) when it still doesn't fit.

# Width the top-right buttons cover, measured from the real buttons, plus a gap.
function Get-ButtonReserve {
    $r = 0.0
    foreach ($b in @($miniButton, $closeButton)) {
        if ($null -eq $b -or $b.Visibility -ne [System.Windows.Visibility]::Visible) { continue }
        $bw = [double]$b.ActualWidth
        if ($bw -le 0) { $bw = [double]$b.Width }
        $r = [Math]::Max($r, $bw + [double]$b.Margin.Right)
    }
    return ($r + 6.0)
}

# Fit one row (Viewbox + its panel) next to the buttons.
function Set-RowFit($box, $panel, [double]$contentW, [double]$reserve, [double]$bottom) {
    $panel.Measure([System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
    $natural = [double]$panel.DesiredSize.Width          # real unscaled width
    $avail = [Math]::Max(20.0, $contentW - $reserve)     # room left of the buttons
    $box.MaxWidth = $avail                               # Viewbox shrinks the row past this
    $eff = [Math]::Min($natural, $avail)
    # Right margin moves the centered row left only as far as needed (0 when it fits):
    # its right edge then lands exactly at the buttons' left edge minus the gap.
    $shift = [Math]::Max(0.0, $eff - $contentW + 2.0 * $reserve)
    $box.HorizontalAlignment = 'Center'
    $box.Margin = [System.Windows.Thickness]::new(0, 0, $shift, $bottom)
}

# Timer typography follows available width (430 px = reference width).
function Update-ResponsiveTypography {
    try {
        $w = [double]$window.ActualWidth
        if ($w -le 0) { $w = [double]$window.Width }
        if ($script:isMini) {
            # Compact layout: unchanged (already good).
            foreach ($tb in @($timerPart1,$timerColon1,$timerPart2,$timerColon2,$timerPart3)) { if ($tb) { $tb.FontSize = 20.0 } }
            $timerBox.MaxWidth = [double]::PositiveInfinity
            $timerBox.HorizontalAlignment = 'Left'
            $timerBox.Margin = [System.Windows.Thickness]::new(4,0,0,0)
            $timerPart1.Width = 44.0
            $timerPart2.Width = 44.0
            $timerPart3.Width = 58.0
            $timerColon1.Width = 10.0
            $timerColon2.Width = 10.0
            return
        }
        $scale = [Math]::Min(1.0, [Math]::Max(0.25, $w / 430.0))
        $m = Get-TimerMetrics $scale $false
        foreach ($tb in @($timerPart1,$timerColon1,$timerPart2,$timerColon2,$timerPart3)) { if ($tb) { $tb.FontSize = $m.Font } }
        $timerPart1.Width = $m.Part
        $timerPart2.Width = $m.Part
        $timerPart3.Width = $m.Part3
        $timerColon1.Width = $m.Colon
        $timerColon2.Width = $m.Colon
        $stepsText.FontSize = [Math]::Max(8.0, 13.0 * $scale)
        $pctText.FontSize = [Math]::Max(8.0, 13.0 * $scale)
        $resultMetrics.FontSize = [Math]::Max(8.0, 13.0 * $scale)

        # Real content width = the Grid both rows live in (window minus border/padding).
        $grid = $timerBox.Parent
        $contentW = if ($grid -and $grid.ActualWidth -gt 0) { [double]$grid.ActualWidth } else { [Math]::Max(1.0, $w - 22.0) }
        $reserve = Get-ButtonReserve
        Set-RowFit $timerBox $timerPanel $contentW $reserve 5.0
        $visibleStats = if ($resultMetrics.Visibility -eq [System.Windows.Visibility]::Visible) { $resultMetrics } else { $statsPanel }
        Set-RowFit $statsBox $visibleStats $contentW $reserve 6.0
    } catch {
        try { ('Layout failed: ' + $_.Exception.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
    }
}


# ── Window placement helpers (mini <-> normal) ───────────────────────────────
# Mini/restore resizes around the widget's CURRENT top-left or top-right corner
# (whichever side of the monitor it sits on), so moving the mini widget and then
# restoring grows it in place instead of jumping back to the old position.

function Get-WindowHandle {
    return ([System.Windows.Interop.WindowInteropHelper]::new($window)).Handle
}

# Work area (screen minus taskbar) of the monitor the widget is on, in WPF DIPs.
function Get-WorkAreaDip {
    try {
        $hwnd = Get-WindowHandle
        $src = [System.Windows.PresentationSource]::FromVisual($window)
        if ($hwnd -ne [IntPtr]::Zero -and $src -and $src.CompositionTarget) {
            $wa = [System.Windows.Forms.Screen]::FromHandle($hwnd).WorkingArea
            $m = $src.CompositionTarget.TransformFromDevice
            $tl = $m.Transform([System.Windows.Point]::new($wa.Left, $wa.Top))
            $br = $m.Transform([System.Windows.Point]::new($wa.Right, $wa.Bottom))
            return [System.Windows.Rect]::new($tl, $br)
        }
    } catch {}
    return [System.Windows.SystemParameters]::WorkArea
}

# Move + resize in ONE native call (no intermediate frame where the window has
# the new size at the old position), then mirror the values into WPF.
function Set-WindowRect([double]$l, [double]$t, [double]$w, [double]$h) {
    try {
        $hwnd = Get-WindowHandle
        $src = [System.Windows.PresentationSource]::FromVisual($window)
        if ($hwnd -ne [IntPtr]::Zero -and $src -and $src.CompositionTarget) {
            $m = $src.CompositionTarget.TransformToDevice
            $p = $m.Transform([System.Windows.Point]::new($l, $t))
            $flags = [uint32](0x0004 -bor 0x0010)   # SWP_NOZORDER | SWP_NOACTIVATE
            [void][SlimyNative]::SetWindowPos($hwnd, [IntPtr]::Zero,
                [int][Math]::Round($p.X), [int][Math]::Round($p.Y),
                [int][Math]::Round($w * $m.M11), [int][Math]::Round($h * $m.M22), $flags)
        }
    } catch {}
    $window.Left = $l; $window.Top = $t
    $window.Width = $w; $window.Height = $h
}

# Resize to $newW x $newH keeping the top edge and the corner nearest the
# monitor edge: right half of the screen -> top-right fixed, else top-left.
function Resize-Anchored([double]$newW, [double]$newH) {
    $l = [double]$window.Left
    $t = [double]$window.Top
    $w = [double]$window.ActualWidth
    if ($w -le 0) { $w = [double]$window.Width }
    $wa = Get-WorkAreaDip
    $anchorRight = (($l + $w / 2.0) -gt ($wa.Left + $wa.Width / 2.0))
    # The anchored corner stays exactly where it is: no clamping / sliding.
    $newL = if ($anchorRight) { $l + $w - $newW } else { $l }
    Set-WindowRect $newL $t $newW $newH
}

function Set-MiniMode([bool]$enable) {
    try {
        if ($enable -eq $script:isMini) { return }

        if ($enable) {
            # Only the SIZE is remembered; the position always follows the widget.
            $script:restoreWidth = [double]$window.ActualWidth
            $script:restoreHeight = [double]$window.ActualHeight
            $script:restoreMinWidth = [double]$window.MinWidth
            $script:restoreMinHeight = [double]$window.MinHeight

            $script:isMini = $true
            $statsBox.Visibility = 'Collapsed'
            $progress.Visibility = 'Collapsed'
            $controlsPanel.Visibility = 'Collapsed'
            $previewWrap.Visibility = 'Collapsed'
            $historyWrap.Visibility = 'Collapsed'
            $bottomPanel.Visibility = 'Collapsed'
            $closeButton.Visibility = 'Visible'

            $window.ResizeMode = 'NoResize'
            $window.MinWidth = 0
            $window.MinHeight = 0
            Resize-Anchored 275 76
            $window.MinWidth = 275
            $window.MinHeight = 76

            $miniButton.Width = 30
            $miniButton.Height = 28
            $miniButton.Margin = [System.Windows.Thickness]::new(0,0,35,0)
            $miniButton.ToolTip = 'Restore CueTimer widget'
            $miniButtonText.Visibility = 'Collapsed'
            if ($restoreIcon) { $restoreIcon.Visibility = 'Visible' }
            Update-ResponsiveTypography
            Update-IdleMode
        } else {
            $script:isMini = $false

            $window.ResizeMode = 'CanResize'
            $window.MinWidth = 0
            $window.MinHeight = 0
            # Grow from the mini widget's current corner (not the pre-mini position).
            Resize-Anchored $script:restoreWidth $script:restoreHeight
            $window.MinWidth = $script:restoreMinWidth
            $window.MinHeight = $script:restoreMinHeight

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
            Update-IdleMode
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
        $statsBox.Visibility = 'Collapsed'
        $progress.Visibility = 'Collapsed'
    } else {
        $statsBox.Visibility = if ($showTimer) { 'Visible' } else { 'Collapsed' }
        $progress.Visibility = if ($showTimer) { 'Visible' } else { 'Collapsed' }
    }
    # History follows the Timer toggle, like the history list in the node.
    $showHistory = $showTimer -and (-not $script:isMini) -and ($script:historyRows -gt 0) -and ($historyPanel.Children.Count -gt 0)
    $historyWrap.Visibility = if ($showHistory) { 'Visible' } else { 'Collapsed' }
}

# ── History list ──────────────────────────────────────────────────────────────
function New-FrozenBrush([byte]$a, [byte]$r, [byte]$g, [byte]$b) {
    $br = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb($a, $r, $g, $b))
    $br.Freeze()
    return $br
}
# Newest row brightest, older rows fade (same idea as the node).
$script:histTextAlpha  = @(0xD9, 0x8C, 0x5C, 0x45)
$script:histStampAlpha = @(0x80, 0x55, 0x3A, 0x2C)

function Format-HistoryEntry($entry) {
    if ($entry -is [string]) {
        return [PSCustomObject]@{ Text = $entry; Stamp = ''; IsError = $false }
    }
    $isError = ([string]$entry.type -eq 'error')
    $text = [string]$entry.time
    if ([string]::IsNullOrEmpty($text)) { $text = '--:--:---' }
    if ($isError) { $text += ' ⚠' }
    if ([int]$entry.frames -gt 0) { $text += ('  {0}f' -f [int]$entry.frames) }
    if ([int]$entry.steps -gt 0) { $text += ('  {0}step' -f [int]$entry.steps) }
    if ([int]$entry.width -gt 0 -and [int]$entry.height -gt 0) {
        $text += ('  {0}×{1}' -f [int]$entry.width, [int]$entry.height)
    }
    # "2026/06/28 15:50" -> "06/28 15:50" (year adds nothing in a short list)
    $stamp = ([string]$entry.stamp) -replace '^\d{4}/', ''
    return [PSCustomObject]@{ Text = $text; Stamp = $stamp; IsError = $isError }
}

function Update-History($state) {
    $items = @()
    if ($null -ne $state.history -and $script:historyRows -gt 0) {
        $items = @($state.history | Select-Object -First $script:historyRows | ForEach-Object { Format-HistoryEntry $_ })
    }
    # Rebuild only when the visible rows actually changed (poll runs 4x/sec).
    $sig = ($items | ForEach-Object { $_.Text + '|' + $_.Stamp }) -join "`n"
    if ($sig -eq $script:historySig) { return }
    $script:historySig = $sig

    $historyPanel.Children.Clear()
    $script:historyRowsUi.Clear()
    for ($i = 0; $i -lt $items.Count; $i++) {
        $it = $items[$i]
        $ai = [Math]::Min($i, $script:histTextAlpha.Count - 1)
        $rgb = if ($it.IsError) { @(0xFF, 0x50, 0x50) } else { @(0x00, 0xFF, 0x66) }

        $row = [System.Windows.Controls.Grid]::new()
        $c0 = [System.Windows.Controls.ColumnDefinition]::new(); $c0.Width = [System.Windows.GridLength]::new(1, 'Star')
        $c1 = [System.Windows.Controls.ColumnDefinition]::new(); $c1.Width = [System.Windows.GridLength]::Auto
        $row.ColumnDefinitions.Add($c0); $row.ColumnDefinitions.Add($c1)

        $main = [System.Windows.Controls.TextBlock]::new()
        $main.Text = $it.Text
        $main.FontFamily = 'Consolas'
        $main.FontWeight = [System.Windows.FontWeights]::SemiBold
        $main.TextTrimming = 'CharacterEllipsis'
        $main.Foreground = New-FrozenBrush $script:histTextAlpha[$ai] $rgb[0] $rgb[1] $rgb[2]
        [System.Windows.Controls.Grid]::SetColumn($main, 0)

        $stamp = [System.Windows.Controls.TextBlock]::new()
        $stamp.Text = $it.Stamp
        $stamp.FontFamily = 'Consolas'
        $stamp.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
        $stamp.Foreground = New-FrozenBrush $script:histStampAlpha[$ai] $rgb[0] $rgb[1] $rgb[2]
        [System.Windows.Controls.Grid]::SetColumn($stamp, 1)

        [void]$row.Children.Add($main)
        [void]$row.Children.Add($stamp)
        [void]$historyPanel.Children.Add($row)
        $script:historyRowsUi.Add([PSCustomObject]@{ Main = $main; Stamp = $stamp })
    }
    Update-HistoryTypography
    Update-TimerVisibility
}

# History font follows window width; the date column is dropped when narrow.
function Update-HistoryTypography {
    $w = [double]$window.ActualWidth
    if ($w -le 0) { $w = [double]$window.Width }
    $scale = [Math]::Min(1.0, [Math]::Max(0.25, $w / 430.0))
    $font = [Math]::Max(10.0, 13.5 * $scale)
    $stampVis = if ($w -ge 300) { 'Visible' } else { 'Collapsed' }
    foreach ($r in $script:historyRowsUi) {
        $r.Main.FontSize = $font
        $r.Stamp.FontSize = $font
        $r.Stamp.Visibility = $stampVis
    }
}

function Update-ResultMetrics($state) {
    $parts = [System.Collections.Generic.List[string]]::new()
    if (-not [bool]$state.running -and $state.history -and $state.history.Count -gt 0) {
        $entry = $state.history[0]
        if ($entry.type -eq 'done') {
            if ([int]$entry.frames -gt 0) { $parts.Add(('{0}f' -f [int]$entry.frames)) }
            if ([int]$entry.steps -gt 0) { $parts.Add(('{0}step' -f [int]$entry.steps)) }
            if ([int]$entry.width -gt 0 -and [int]$entry.height -gt 0) {
                $parts.Add(('{0}×{1}' -f [int]$entry.width, [int]$entry.height))
            }
        }
    }
    $nextText = $parts -join '  |  '
    $showResult = -not [string]::IsNullOrEmpty($nextText)
    $nextVisibility = if ($showResult) { 'Visible' } else { 'Collapsed' }
    if ($resultMetrics.Text -ne $nextText -or $resultMetrics.Visibility.ToString() -ne $nextVisibility) {
        $resultMetrics.Text = $nextText
        $resultMetrics.Visibility = $nextVisibility
        $statsPanel.Visibility = if ($showResult) { 'Collapsed' } else { 'Visible' }
        Update-ResponsiveTypography
    }
}

function Update-PreviewVisibility {
    $localOn = $true
    if ($previewToggle -and $null -ne $previewToggle.IsChecked) { $localOn = [bool]$previewToggle.IsChecked }
    $previewWrap.Visibility = if ((-not $script:isMini) -and $localOn -and $script:remotePeepVisible) { 'Visible' } else { 'Collapsed' }
    Update-VideoPlayback
}

# True only when the preview area can actually be seen. When it can't
# (minimized / mini mode / Peep off) we skip video decoding, preview downloads
# and the frame-flip animation, which is where the widget's CPU/GPU goes.
function Test-PreviewNeeded {
    if ($window.WindowState -eq [System.Windows.WindowState]::Minimized) { return $false }
    if ($script:isMini) { return $false }
    return ($previewWrap.Visibility -eq [System.Windows.Visibility]::Visible)
}

# Single place that decides whether the final video decodes or sits paused.
function Update-VideoPlayback {
    if (-not $finalVideo) { return }
    if (-not $script:hasFinalVideo) {
        $script:videoPlaying = $false
        if ($pauseBadge) { $pauseBadge.Visibility = 'Collapsed' }
        return
    }
    $shouldPlay = (Test-PreviewNeeded) -and (-not $script:userPaused)
    try {
        if ($shouldPlay -and -not $script:videoPlaying) {
            $finalVideo.Play()
            $script:videoPlaying = $true
        } elseif (-not $shouldPlay -and $script:videoPlaying) {
            $finalVideo.Pause()
            $script:videoPlaying = $false
        }
    } catch {}
    if ($pauseBadge) {
        $pauseBadge.Visibility = if ($script:userPaused) { 'Visible' } else { 'Collapsed' }
    }
}

function Switch-VideoPause {
    if (-not $script:hasFinalVideo) { return $false }
    $script:userPaused = -not $script:userPaused
    Update-VideoPlayback
    return $true
}

function Update-IdleMode {
    # Minimized: slow polling and stop the flip animation entirely.
    $minimized = ($window.WindowState -eq [System.Windows.WindowState]::Minimized)
    $ms = if ($minimized) { $script:pollIdleMs } else { $script:pollActiveMs }
    if ($pollTimer -and $pollTimer.Interval.TotalMilliseconds -ne $ms) {
        $pollTimer.Interval = [TimeSpan]::FromMilliseconds($ms)
    }
    if ($flipTimer) {
        if (Test-PreviewNeeded) { if (-not $flipTimer.IsEnabled) { $flipTimer.Start() } }
        elseif ($flipTimer.IsEnabled) { $flipTimer.Stop() }
    }
    Update-VideoPlayback
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
    $script:videoPlaying = $false
    $script:userPaused = $false
    if ($pauseBadge) { $pauseBadge.Visibility = 'Collapsed' }
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
        $script:userPaused = $false   # a new render always starts playing
        $script:videoPlaying = $false
        $finalVideo.Position = [TimeSpan]::Zero
        # Paused (not playing) when nothing is visible: shows the first frame on
        # restore without decoding the whole loop in the background meanwhile.
        $finalVideo.Pause()
        Update-VideoPlayback
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
            if ($script:videoPlaying) { $finalVideo.Play() }
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
    if (-not (Test-PreviewNeeded)) { return }
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

$window.Add_SizeChanged({ Update-ResponsiveTypography; Update-HistoryTypography })
# Minimize / restore: drop to near-idle while minimized, resume on restore.
$window.Add_StateChanged({ Update-IdleMode })
if ($previewWrap) { $previewWrap.ToolTip = 'Click: play / pause video   Double-click: mini mode' }
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
        Update-ResultMetrics $s
        try { Update-History $s } catch {
            try { ('History update failed: ' + $_.Exception.Message) | Add-Content -Encoding UTF8 $script:logPath } catch {}
        }

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
        } elseif ($ver -ne $script:lastPreviewVersion -and (Test-PreviewNeeded)) {
            # (Skipped while the preview can't be seen; lastPreviewVersion stays
            # behind, so the newest image is fetched as soon as it is visible again.)
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
            # The first click of this double-click already toggled play/pause;
            # undo it so a double-click means only "mini mode".
            if (([DateTime]::UtcNow - $script:clickToggledAt).TotalMilliseconds -lt 800) {
                $script:userPaused = -not $script:userPaused
                $script:clickToggledAt = [DateTime]::MinValue
            }
            Set-MiniMode $true
            return
        }

        # Single click on the final video: play/pause. Still a drag surface:
        # DragMove() returns on mouse-up, and only an unmoved press counts as a click.
        if ($inPreview -and $script:hasFinalVideo) {
            $e.Handled = $true
            $x0 = $window.Left; $y0 = $window.Top
            try { $window.DragMove() } catch {}
            if ([Math]::Abs($window.Left - $x0) -lt 1 -and [Math]::Abs($window.Top - $y0) -lt 1) {
                if (Switch-VideoPause) { $script:clickToggledAt = [DateTime]::UtcNow }
            }
            return
        }

        # Interactive controls must remain clickable, not become drag surfaces.
        $cur = $src
        while ($null -ne $cur) {
            if ($cur -eq $timerToggle -or $cur -eq $previewToggle -or $cur -eq $peepSoundToggle -or $cur -eq $topmostToggle -or $cur -eq $parentButton -or $cur -eq $closeButton -or $cur -eq $miniButton) { return }
            try { $cur = [System.Windows.Media.VisualTreeHelper]::GetParent($cur) } catch { break }
        }

        $p = $e.GetPosition($window)
        # No resize band in mini mode, so the whole widget can be dragged.
        $b = if ($script:isMini) { -1.0 } else { 8.0 }
        if ($p.X -gt $b -and $p.X -lt ($window.ActualWidth - $b) -and
            $p.Y -gt $b -and $p.Y -lt ($window.ActualHeight - $b)) {
            $e.Handled = $true

            # Double-click anywhere on the widget (digits, stats, frame, empty area)
            # toggles mini mode. ClickCount is unreliable here because the first click
            # runs DragMove(), so also compare time / position with the last unmoved click.
            $dblMs = 500.0
            try { $dblMs = [double][SlimyNative]::GetDoubleClickTime() } catch {}
            $isDouble = ($e.ClickCount -ge 2)
            if (-not $isDouble -and $script:lastBlankClickAt -ne [DateTime]::MinValue) {
                $dt = ([DateTime]::UtcNow - $script:lastBlankClickAt).TotalMilliseconds
                if ($dt -le $dblMs -and
                    [Math]::Abs($p.X - $script:lastBlankClickX) -le 6.0 -and
                    [Math]::Abs($p.Y - $script:lastBlankClickY) -le 6.0) { $isDouble = $true }
            }
            if ($isDouble) {
                $script:lastBlankClickAt = [DateTime]::MinValue
                Set-MiniMode (-not $script:isMini)
                return
            }

            $x0 = $window.Left; $y0 = $window.Top
            $window.DragMove()
            if ([Math]::Abs($window.Left - $x0) -lt 1 -and [Math]::Abs($window.Top - $y0) -lt 1) {
                # Unmoved press = a click; remember it for double-click detection.
                $script:lastBlankClickAt = [DateTime]::UtcNow
                $script:lastBlankClickX = $p.X
                $script:lastBlankClickY = $p.Y
            } else {
                $script:lastBlankClickAt = [DateTime]::MinValue
            }
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
        if ($script:isMini) {
            # Mini widget can't be resized anyway: treat the whole window, edges
            # included, as client so a double-click on the frame also restores it.
            $handled.Value = $true
            return [IntPtr]1
        }
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
