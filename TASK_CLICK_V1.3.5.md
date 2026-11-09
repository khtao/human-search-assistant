# Task-card click redesign · v1.3.5

## What changed

### Browser extension
- Task pages are now limited to `/dashboard` and `/earn` for a consistent two-page flow.
- Cards are re-identified by stable href / offer index / badge index before using a DOM marker.
- The aim step scrolls the card into view and uses `elementFromPoint` to reject covered or non-hit-testable points.
- Clicks use CDP `Input.dispatchMouseEvent` only.
- The old `human.click` DOM-synthetic fallback is disabled.
- Newly opened tabs are detected with a short polling window and awaited until navigation completes.
- A mouse release is attempted even if the user stops the task after mouse-down.

### Electron desktop app
- The old `HTMLElement.click()` path was replaced by a CDP mouse sequence sent through `webContents.debugger`.
- Task cards are re-located immediately before each click; cached element references are checked against the expected title, href and points.
- A visible task viewport is ensured before dispatching input.
- `target=_blank` pages are routed to the hidden result view and awaited; same-page navigation restores the source task page.
- CDP failures are reported. The desktop wrapper no longer falls back to the old synthetic-click implementation.

## Validation

- `npm run verify`: all included regression suites pass.
- `node --check` passes for the changed JavaScript files.
- `verify-task-click-v135.js` tests the three-event CDP sequence and both app paths.
- Live Microsoft Rewards validation still requires a logged-in browser session on the user's machine. The test suite does not claim that a live account awarded points.

## Install

- Browser extension: load the `edge-extension/` directory as an unpacked extension.
- Desktop app: enter `desktop-app/`, run `npm run ci` if dependencies are not installed, then run `npm start` or build the platform package with the existing build script.
