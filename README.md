# Chaos Deck

A private streaming panel for VRChat. Watch the in-game camera, chat with friends, and let trusted admins control avatar effects.

The player fills the screen, with controls that fade while you watch. Accounts and chat are saved locally, and friends join through invitations.

## What you need

| Host running VRChat | Friends watching |
| --- | --- |
| Windows 10/11, 64-bit | A current desktop or mobile browser |
| [Node.js 24 or newer](https://nodejs.org/) | The host's panel URL |
| [64-bit Python 3.12 or 3.13](https://www.python.org/downloads/windows/) | An invitation code for the first visit |
| VRChat with OSC and Spout Stream enabled | No Node.js, Python or VRChat installation needed |

This version captures and serves the stream on the Windows host. Ubuntu relay deployment and automatic first/third-person camera switching are not implemented yet.

## First launch

1. Extract the project into a writable folder, or clone the repository.
2. Run **Setup Camera.cmd** once. It installs camera/audio dependencies into the project folder. No `npm install` is needed.
3. Run **Start Chaos Deck.cmd**. The launcher opens your local panel; keep its console window open.
4. Create your admin account. There is no default username or password. The **Help & setup** guide opens after setup.
5. In VRChat, enable **Action Menu → OSC → Enabled** and **Camera → Stream → Spout Stream**.
6. In the panel's **Settings**, choose your audio inputs and select **Start stream**. Check whether you want your microphone included before starting.

Return to **Help & setup** from Settings or your profile whenever you need it. For missing prerequisites, follow [Troubleshooting](docs/TROUBLESHOOTING.md).

## Invite friends

Start your chosen HTTPS tunnel to port **3210**, then save its exact public URL in **Settings → Sharing & access**. Create an invitation under **Manage accounts & invites** and share the URL plus the code.

Each friend creates an individual account. New accounts can watch and chat. Only admins can send avatar commands, change broadcast settings or manage accounts.

The panel stays bound to localhost. A working tunnel or reverse proxy is required for internet access. Video is sent separately to every viewer, so check your host upload speed and your tunnel's video/traffic limits. This release supports up to eight simultaneous stream connections.

## Everyday controls

- **Watching:** click the speaker to hear audio. Move your pointer or tap to reveal controls.
- **Avatar:** find useful parameters by name/category. Integer sliders apply on release; the number updates while dragging. Advanced parameters remain tucked away.
- **Effects:** play short, automatically ending cues. Held movement releases when you let go.
- **Chat:** Enter sends; Shift+Enter adds a line. Admins can remove messages.
- **Chat in VRChat:** admins can optionally enable a rolling three-message chatbox feed in Settings.
- **Your account:** change your password, sign out, or fit the full camera frame.
- **Stopping a broadcast:** select **Disconnect camera** in Settings. An active broadcast otherwise resumes after a server restart.

Avatar controls depend on the avatar's configuration. A sent command is not proof that the avatar accepted it; feedback is shown when available. The stream targets 1080p60 by default, with lower resolution/frame-rate options.

## Password recovery and backups

Forgot the admin password? On the host PC, run **Reset Admin Password.cmd**. If one active admin exists, it is selected automatically. For a specific account, run `node scripts/reset-admin.js YourUsername`.

Accounts, invitations, chat and settings live in **data/chaos-deck.sqlite**. To back up the installation, stop Chaos Deck and copy the **data** folder. Keep that folder when updating to a new version. Password recovery preserves it.

## Developer commands

Requires Node.js 24 or newer.

```sh
npm start                 # Start the local panel
npm run doctor            # Check local setup without changing it
npm test                  # Run isolated tests
npm run package:release   # Build a clean Windows release ZIP
```

There are no external npm dependencies. Camera dependencies are installed separately by Setup Camera.cmd.

See [Troubleshooting](docs/TROUBLESHOOTING.md), the [technical reference](docs/REFERENCE.md), and the [release guide](docs/RELEASING.md).
