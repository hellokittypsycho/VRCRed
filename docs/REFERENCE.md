# Chaos Deck

A private Node.js player for VRChat’s in-game Spout camera, with live chat, persistent accounts and admin-only OSC controls.

## Start

Requires Windows, Node.js 24+, VRChat, and 64-bit Python 3.12 or 3.13 for the camera dependencies.

1. Run `Setup Camera.cmd` once.
2. Run `Start Chaos Deck.cmd`, or `npm.cmd start`.
3. Open http://127.0.0.1:3210/. For a new installation, create the first admin account locally and follow Help & setup. On later visits, sign in with the account you created. Migrated shared-password installations use username **admin**.
4. Enable **Action Menu → OSC → Enabled** and **Camera → Stream → Spout Stream** in VRChat, then use **Start stream** in the admin panel.

All permitted avatar commands send live OSC. Preview mode and the separate enable/arming step have been removed.

## Accounts and invitations

Each person signs in with their own username and password. New accounts can only be created with a valid invitation and always start as **viewers**. Usernames are case-insensitive and use 3–24 letters, digits, underscores or hyphens. Passwords must be 12–256 characters.

Admins open **Settings → Manage accounts & invites** to create invitations, promote viewers to admins, revoke invitations or disable accounts. Invitations are single-use by default, with configurable usage limits and 1-, 7- or 30-day expiry. A newly generated invitation code is shown only in that admin view; copy it before closing the dialog. Existing codes cannot be retrieved from the database. Share an invitation code alongside the panel’s URL.

Viewers can watch, chat, mute, enter fullscreen and manage their own account. Only admins can trigger avatar parameters, movement, effects, restore commands, camera/audio changes, chat relay settings, network changes or account/invitation management. The server enforces permissions independently of the UI. Changing someone’s role or disabling them signs out their sessions and releases any movement they own. An admin cannot change their own permissions in this panel.

The profile button opens **Your account**, including personal fit-frame preference, password change and sign-out. Password changes require the current password and sign out other sessions. Sign-ins last up to 30 days and survive server restarts unless revoked.

### Migration from shared passwords

On first startup, the previous `.deck-access.json` is imported automatically. Its host password becomes the password for username **admin**, and the saved ngrok URL is retained. The previous friends password becomes a registration invitation valid for seven days and up to 25 new viewer accounts. Admins can revoke this invitation from the invitation list. There is no shared friends login after migration.

The original JSON is retained unchanged as a backup; SQLite is used after migration. Passwords are migrated as existing salted hashes, without recovering or changing the passwords. Accounts created afterward use new salted scrypt hashes.

## Forgotten admin password

On the host PC, run **Reset Admin Password.cmd** or `npm.cmd run reset:admin` while the panel is running. Open the printed local recovery page (normally http://127.0.0.1:3212/) and enter the new password twice. It resets only the selected admin, signs that browser into the panel, and revokes previous sessions for that admin. Accounts, invitations, chat and other users’ sessions are kept.

Recovery is a separately launched, one-use local utility that expires after ten minutes; it is not exposed by the main panel or through ngrok. Close its console to cancel. If it expires, run it again. When there is one active admin, recovery selects that account automatically. To choose a specific admin username, use `node scripts/reset-admin.js YourUsername`. Passwords are entered only in the browser form, never as command-line arguments. Do not delete the database to reset a password.

## Live chat

**Chat** opens a side panel over the video, without adding page scrolling. Messages appear live through the existing SSE connection, show the authenticated username, and display an admin badge where applicable. The server supplies the author identity; a client cannot choose another username or role for its messages.

Messages are plain text, up to 500 characters, limited to five messages per account every ten seconds. Admins can remove individual messages. The panel shows the latest 100 messages; SQLite retains at most 1,000 messages across streams. Removed message bodies are cleared and replaced with a moderation notice. Unread counts, online-account count and a jump-to-new-messages button are included. Multiple browser tabs count as one online account.

## Friends over ngrok

Run `ngrok http 3210` using your configured ngrok installation. In the **local admin panel**, save ngrok’s exact HTTPS URL under Settings → Sharing. Then share that URL and an invitation code. See [ngrok’s official localhost guide](https://ngrok.com/use-cases/share-localhost).

The server stays bound to `127.0.0.1`; only local hostnames and the saved public hostname are accepted. Update the saved URL when the ngrok address changes. Initial admin setup is refused through forwarded requests. Save the public URL locally before opening it remotely, and do not rewrite the Host header in ngrok.

Video, audio, chat, state updates and commands use the same HTTP tunnel. No forwarded UDP media port or TURN server is needed. Up to eight simultaneous stream connections are supported. The encode is shared, but every viewer needs a separate outgoing copy: expect roughly 3–7 Mbps upload per viewer for 1080p, depending on scene complexity. Ngrok plan/data limits and upload speed can limit viewing. Internet delivery still needs testing from a friend’s connection after starting the tunnel.

## Camera and controls

The actual in-game Spout camera is encoded as H.264 video with AAC stereo audio in fragmented MP4. The default is **1920×1080 with a 60 FPS target**, with 720p and 15/30 FPS options in admin settings. Actual FPS depends on VRChat and encoding performance. The player uses Media Source Extensions where available and catches up if playback falls behind. Playback retries automatically after network failures or stalls, with a capped retry delay. The receiver also restarts automatically after a crash or encoding stall, and refreshes stale Spout connections. There is no manual restart-stream button.

Audio combines VRChat’s process audio and the selected microphone. It does not capture other apps’ desktop sound or use browser window capture. The default input is Windows’ default microphone; admins can refresh the microphone list, select another input and apply stream settings. Game audio and microphone capture can each be turned off. Viewers start muted and click the speaker to hear audio. The active stream settings and broadcast intent are saved in SQLite. Restarting the server resumes a previously active stream, including its selected audio inputs. Use **Disconnect camera** to stop broadcasting and keep it off across restarts; signing out or viewers leaving does not stop broadcasting. **Start stream** appears only when the broadcast is stopped, and **Apply stream settings** is enabled only when settings differ. No video or audio is recorded to disk.

The player fills the viewport. The bar fades after three seconds of inactivity and returns on pointer movement, taps or keyboard navigation. Menus and open chat keep controls visible. Avatar controls use a searchable, paged popup with readable names and favorites. Internal parameters and duplicate aliases are hidden by default. Names change presentation only; original OSC addresses remain intact. Integer avatar controls use whole-step sliders with a selected-value readout; releasing the slider applies its value automatically (keyboard adjustments also apply). Standard expression values use 0–255; emote slots use 0–16 including reset. Existing observed values outside those ranges remain reachable. Advanced custom input remains available for exact numeric values.

Effects provides bounded spin, wiggle, hop and emote cues. Held movement expires after 350 ms unless renewed. One admin owns movement at a time; another account leaving cannot interrupt it. Escape closes menus, fullscreen or chat and releases held movement. There is no stop-all-effects button or shortcut. Restore changes returns tracked parameter baselines. Latched toggles remain when a viewer leaves. A force-killed process or OS crash cannot deliver OSC release packets.

In **Settings → Stream chat**, admins can enable **Relay chat to VRChat** (off by default, saved in SQLite). It shows a rolling feed with a shared `STREAM CHAT` heading and up to three recent lines such as `Mosa › Hello guys!`, oldest to newest. Each OSC update includes the whole feed so previous lines remain visible when VRChat replaces the chatbox. Full authenticated names are retained and long bodies share the 144 UTF-16 unit limit, with truncation at grapheme boundaries. The website keeps full messages. Updates coalesce at most once every 3 seconds with notification sounds disabled; busy chat keeps the latest three rather than queuing a backlog. Context older than 30 seconds is omitted from the next update; quiet chat fades normally without refreshes. Disabling clears buffered context. Moderation removes messages from subsequent updates, including a blank update if nothing remains. Enable OSC in VRChat; player chatbox visibility settings still apply. Website history and restarts never replay old messages.

OSCQuery optionally reads current values and verifies parameter writes. A sent packet alone does not confirm avatar execution. Tracking and avatar logic can overwrite parameters. Avatar configuration JSON files are read from VRChat’s local OSC folder and never edited. Live state updates resend avatar definitions only when the catalog changes, keeping large configurations from interrupting chat or repeatedly consuming bandwidth.

## Data, backups and development

Persistent data lives in **data/chaos-deck.sqlite**, with SQLite WAL/SHM sidecars while running. Accounts, invitations, login-rate limits, hashed session tokens, sharing configuration and chat history live in this database. The ignored `data/` directory must be retained for future streams. To back up or restore it, stop the server first and copy the directory. Do not delete it to change a password; that would also remove accounts and chat.

Passwords use salted scrypt hashes. Invitation codes and session-cookie tokens are stored as hashes. Session cookies are HttpOnly and SameSite=Strict; public HTTPS sessions also use Secure. Writes require the session’s CSRF token and accepted Origin/Host headers. Login throttling survives server restarts. Only first-admin setup is allowed without an invitation, and only through direct local requests.

Camera wheels are installed in `.camera-deps/`, with an interpreter path in `.camera-runtime.json`. On another machine run `Setup Camera.cmd` or `npm.cmd run setup:camera`. To select Python explicitly: `node scripts/setup-camera.js "C:\Path\To\python.exe"`. The helper does not install Python. It uses [SpoutGL](https://github.com/jlai/Python-SpoutGL), [PyAV](https://pyav.org/), [ProcTap](https://github.com/m96-chan/ProcTap) and [sounddevice](https://python-sounddevice.readthedocs.io/). The capture worker also watches the server process and exits if it disappears, so a crashed server does not leave microphone capture running.

`npm.cmd test` checks OSC, config discovery, live command lifetimes, SQLite persistence, invitation races, authorization, session revocation, chat delivery/moderation, migration, large-catalog streaming, receiver crash/stall recovery, disconnect cancellation, broadcast resumption and MP4 framing against temporary fixtures and mock UDP receivers. Node uses built-in HTTP, UDP, crypto and SQLite modules and has no external npm dependencies. The source is split across `server.js`, `lib/access.js`, `lib/database.js`, `lib/chat.js`, the camera helpers and `public/`.
