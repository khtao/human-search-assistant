# Human Search Assistant · Browser Extension

Version: 1.3.7

## v1.3.7 behavior parity

The extension and desktop app use the same exact 100% completion gate and `skipCompletedCards` setting. When the latest task summary is fully earned, automatic task execution returns without opening cards or starting a search run. The desktop settings page mirrors the extension settings page.

## Install

1. Extract the complete project archive.
2. Open `edge://extensions` (Microsoft Edge) or `chrome://extensions` (Chromium-based Chrome).
3. Enable Developer mode.
4. Choose **Load unpacked** and select this `edge-extension/` folder.
5. Reload the extension after updating.

## Task-card click flow (v1.3.7)

When the extension synchronizes Rewards points and the task list, it also creates a `taskClickIndex` from the same `/dashboard` and `/earn` HTML responses. The index stores task identity, page, full destination href, `data-bi-id`, offer/test IDs, element ID, accessible label, title, points, target and anchor order. It deliberately does not store coordinates or DOM references.

The click flow reads this index directly instead of fetching and scanning the full pages again. It first matches stable href/DOM attributes, then uses title + points as a constrained fallback. Only if the indexed element is not currently rendered does it perform a small, bounded lazy-load scroll and retry the same indexed lookup. It then recomputes the live rectangle, checks the hit-test point and sends CDP mouse input (`mouseMoved`, `mousePressed`, `mouseReleased`).

The task-card path does not use `HTMLElement.click()`, synthetic DOM mouse events, or direct URL navigation as a substitute. Click dispatch, task-page response and points credit are treated as separate states. An index older than 30 minutes is rejected; the automatic run refreshes the index before clicking.

The extension requires the `debugger` permission already declared in `manifest.json`. Browser vendors may display a debugging/automation notice while this permission is active.
