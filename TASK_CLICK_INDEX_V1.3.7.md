# Task Click Index and Runtime Reliability · v1.3.7

## 1. Exact completion gate

Both the Edge extension and Electron desktop app now use the same `isTaskSummaryComplete()` rule. A run is considered complete only when the latest synchronized summary has a positive total and `earned >= total`. The summary percentage is floored for incomplete totals, so a value such as 99.5% is displayed as 99%, not 100%.

When the synchronized summary is complete, the automatic-task flow returns before calling the task-card click routine or starting the search phase. The result reports `reason: allDone`, `clicked: 0`, and `searches: 0`.

## 2. Settings parity

The desktop settings page now uses the same control IDs, order, and labels as the Edge extension. Both expose `skipCompletedCards`, defaulting to `false` (include all scored cards while the overall daily task total is incomplete). When enabled, completed cards are filtered before the click action.

The desktop-only cooldown controls were removed from the visible settings page because they did not exist in the extension UI and the `cooldownAware` toggle was not used by the search flow. Existing persisted values are harmless and are ignored by the current visible settings.

## 3. Login-state protection

Previously, any removed cookie on a broad Bing / Live / Microsoft domain could be interpreted as a sign-out and clear the cached available-points value. Cookie deletion is no longer treated as an authoritative logout signal, including removal of recognized authentication cookies. This prevents Microsoft authentication-ticket rotation during the login-button navigation from clearing points.

Only an explicit `/logout` or `signout` navigation directly marks the account as signed out; otherwise the next Rewards page synchronization determines the login state. Cookie values are never logged.

## 4. Desktop runtime and memory lifecycle

- Debug capture does not create a session directory or flush timer when disabled.
- Recent debug log/event buffers are bounded (80 / 120 entries).
- Enabled debug write queues are bounded (2,000 log lines / 4,000 events).
- The debug flush timer and process-exit listener are released on application shutdown.
- Host-message guard timers are cleared when a queued message resolves early.
- Task-page load timeout removes its pending `did-finish-load` listener and clears its timer.
- Tab references are cleaned when either a BrowserWindow closes or a WebContentsView is destroyed.

The task index remains bounded to the current synchronized task set and is replaced on each successful sync; it does not accumulate historical task DOM nodes or coordinates.

## 5. Verification

Run from `desktop-app/`:

```bash
npm run verify
```

The v1.3.7-specific stability/parity suite is also available separately:

```bash
npm run verify:v137
```

The full default verification suite passed **541 checks, 0 failures** in the build container. This is source-level and headless integration verification; a real Microsoft Rewards account and live desktop session are still required for end-to-end sign-in and task-credit confirmation.
