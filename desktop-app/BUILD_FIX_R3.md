# r3 build fix

The Debian package build failed because electron-builder's FPM target requires project homepage metadata.

This revision adds the project homepage and repository metadata to `package.json`:

- homepage: https://github.com/khtao/human-search-assistant
- repository: https://github.com/khtao/human-search-assistant.git

No application runtime logic or Electron version was changed. The dependency lockfile remains unchanged.

In an existing r2 checkout, the minimal fix is to add the `homepage` field to the root `package.json`, then rerun `npm run build:linux`.
