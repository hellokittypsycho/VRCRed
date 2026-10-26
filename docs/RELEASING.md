# Preparing a project release

## Build a clean archive

Run `npm test`, then `npm run package:release` on Windows. The ZIP appears under **releases/** and opens directly into the project files. `npm pack` is also available for a source tarball.

The ZIP builder uses an explicit file list and approved source directories. It includes the app, launchers, tests, scripts and docs. It excludes **data**, SQLite files, the legacy access file, local Python dependencies/interpreter paths, environment files, logs, screenshots, benchmark results and previous release archives. Build from source; do not zip the entire working folder by hand.

The working folder's personal data is never included or reset. Every fresh installation creates its own first admin account and camera runtime.

## Before publishing

Choose the project's license and add its LICENSE file. The archive builder includes it when present; it does not choose a license for you. Set the repository URL and release version in package.json when the repository exists. Package.json remains private to prevent accidental npm publication.

Check these flows on a clean Windows machine or VM with the real VRChat client:

- Missing Node.js, unsupported Python, and first camera dependency installation.
- Launch, first-admin setup and the automatically opened help guide.
- Start the camera with game audio and the chosen microphone; reconnect after interruptions.
- Invite a viewer from another network and verify watching, audio, chat and denied admin actions.
- Avatar controls on representative avatars, including slider release and feedback.
- Recovery for an admin whose username is not `admin`.
- Close, restart and update while retaining the same accounts and settings.

Automated tests use temporary databases and mock OSC receivers. They do not replace a fresh-machine install or a real internet/browser test.

## Current scope

The host is Windows-only for Spout and audio capture. This build still uses the existing shared H.264/AAC encode and sends one copy to each viewer. The bandwidth benchmark compares alternatives without changing production encoding. Cloud relaying, OBS scene integration, and automatic camera perspective presets are separate future work.
