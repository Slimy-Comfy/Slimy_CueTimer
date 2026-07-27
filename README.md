# Slimy_CueTimer

[![Slimy_CueTimer](https://github.com/Slimy-Comfy/Slimy_CueTimer/raw/main/screenshot.jpg)](https://github.com/Slimy-Comfy/Slimy_CueTimer/blob/main/screenshot.jpg)

A queue progress monitor accessory for ComfyUI. Track rendering progress, processing speed, history, and live preview — all from a single node.

---

## Features

- Automatically starts a time count when the queue runs, measuring the time to completion
- Notifies via system notification and sound when the queue finishes
- Displays the preview image output by KSampler
- PeepPreview works in real time even when KSampler is inside a subgraph
- No node connections required — place it anywhere convenient in your workflow

---

## Main Features

### Progress Display

- Steps progress bar
- Total progress bar
- Processing speed (it/s)
- Completion percentage (%)
- Elapsed time
- Remaining time

> **Note: Total progress is estimated from recent render history to predict overall progress and remaining time.**

### History

- Shows the latest 5 entries
- Scroll through entries one at a time with the ▲▼ buttons
- History is retained after processing finishes

### PeepPreview

Displays KSampler's internal preview image in real time.
Can be toggled to show or hide.

### Notifications

- **SystemNotify**: Shows a system notification when processing finishes
- **PeepSound**: Plays a notification sound when processing finishes

---

## Use Cases

- Monitoring long-running renders
- Tracking batch processing progress
- Real-time preview of generated images
- Estimating render time

---

## Requirements

- ComfyUI
- Slimy Custom Nodes

---

## Changelog

### v1.0

- Two progress bars: Steps / Total
- History display (5 entries)
- History scroll buttons
- PeepPreview
- Toggle preview visibility
- SystemNotify
- PeepSound
- Elapsed time / remaining time / processing speed display
