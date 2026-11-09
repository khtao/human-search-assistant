# Human Search Assistant v1.3.8

This source bundle contains both the Electron desktop application and the Edge/Chromium browser extension.

## What changed in v1.3.8

- **Points earning calendar** (Settings): a calendar-style grid showing only the points earned per cell, with no date numbers. Switch between Day / Week / Month aggregation; history is recorded on every points sync (`pointsHistory`, keyed by local date).
- **Language order**: 中文 → English → 跟随系统 (Chinese → English → System) on both platforms.
- **Detailed progress text** reuses the existing status line below the ring (no new text box): one concise but informative bilingual line — sync progress + which pages, today/available points, page/card name and index, next action, search index + keyword, plus a live **countdown** for delayed actions. Long lines ellipsize and reveal the full text on hover. Written as `activityDetail` with an `until` timestamp.
- **Desktop-only options** (off by default, shown only in the desktop settings): launch at login and silent task completion. Silent mode hides page views only; the sync / click / search flow and all progress details are identical to a normal run. The extension does not show this group.
- **Calendar (Alipay-style earnings calendar)**: a large period-total figure on top, then flat rounded-square cells — past days without points are light grey, future days show no cell, days with points are light blue, today gets a thin ring. Cells show points only; the date and details appear on hover.
- **No inline hints in settings**: all explanatory small print was moved to a lightweight custom hover tooltip (bilingual, follows language switches) instead of the native black title box.

Historical v1.3.7 notes follow.

## What changed in v1.3.7

The Rewards synchronization pass now builds a `taskClickIndex` from the same Dashboard and Earn page responses used for points and task-list parsing. The index stores task identity, page, href, target, and stable DOM attributes (for example `data-bi-id`, `data-offer-id`, `id`, and `aria-label`); it never stores stale coordinates or DOM references.

Automatic clicking consumes that index directly. It no longer performs a second full-page card scan. Before each click it resolves the indexed task in the current DOM, recomputes the live rectangle, verifies the hit-test point, and sends Chromium CDP mouse input (`mouseMoved` → `mousePressed` → `mouseReleased`). A small bounded scroll/retry is used only when the indexed card is not currently rendered. DOM `.click()`, synthetic mouse events, and direct URL opening are not used as substitutes.

Click dispatch, task-page response, and points credit remain separate statuses. An index older than 30 minutes is rejected; automatic runs refresh it before clicking.

See [CHANGELOG_V1.3.8.md](CHANGELOG_V1.3.8.md) for the v1.3.8 upgrade details, and [TASK_CLICK_INDEX_V1.3.7.md](TASK_CLICK_INDEX_V1.3.7.md) / [CHANGELOG_V1.3.7.md](CHANGELOG_V1.3.7.md) for the previous release.

## Browser extension

1. Extract the archive.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable Developer mode.
4. Select **Load unpacked** and choose `edge-extension/`.

The extension requires the `debugger` permission for CDP mouse input.

## Ubuntu desktop application

See `desktop-app/README.md`. On Ubuntu/Debian x86_64, install the system build tools and run from `desktop-app/`:

```bash
sudo apt install -y build-essential dpkg-dev fakeroot
npm run build:linux
```

The DEB build itself should be performed on the target Ubuntu/Debian system. This delivery contains source code and verification scripts, not a prebuilt `.deb`.

## Verification

From `desktop-app/`:

```bash
npm run verify
```

The default suite includes the original regression checks, the CDP mouse-click checks, 38 task-index checks, 50 v1.3.7 stability/parity checks, and 166 v1.3.8 upgrade checks. The full suite passed 710 checks with zero failures in the build container.
