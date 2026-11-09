# v1.3.7 — login, completion, parity, and runtime stability

## Fixed

- Desktop login-panel navigation no longer treats any Cookie deletion as an authoritative logout; only an explicit logout/signout navigation clears the cached available-points state.
- Authentication-cookie rotation during the login-button navigation is also ignored; Cookie changes alone never clear the cached points.
- Both platforms now stop before opening task cards when the latest synchronized task total is fully earned.
- Incomplete progress is floored rather than rounded, so 99.5% is not shown as 100%.
- Desktop task-card filtering now honors the same `skipCompletedCards` setting as the browser extension.

## Aligned

- Desktop and Edge settings controls now have the same IDs and order.
- Added the `skipCompletedCards` setting to desktop; default is `false` on both platforms.
- Removed the desktop-only visible cooldown controls that had no matching extension setting.
- Updated both application versions to 1.3.7.

## Performance and memory

- Disabled debug mode no longer creates an empty capture session or interval timer.
- Debug log/event buffers and pending write queues now have fixed upper bounds.
- Debug timers/listeners are closed on app shutdown.
- Cleared host-message timeout guards after early completion.
- Cleaned task-page load listeners/timers and WebContentsView tab references on destruction.

## Verification

`npm run verify`: **541 passed, 0 failed**. This includes unit/static checks, headless Electron integration checks, task-index checks, and the new v1.3.7 stability/parity suite. Real-account UI validation is not claimed.
