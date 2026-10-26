# Troubleshooting

Start with **Help & setup** in the panel. On the host PC you can also run `npm run doctor` from the project folder. It checks prerequisites without changing passwords, stream settings or saved data.

## The launcher closes or says Node.js is missing

Install Node.js **24 or newer**, then open a new terminal or run Start Chaos Deck.cmd again. `node --version` shows the installed version. Running from a writable extracted folder avoids permission problems. You do not need to run the panel as administrator.

If the panel is already running, the launcher opens that panel instead of starting another copy. Keep its original server console open. If another application owns port 3210, close that app or set `PORT` before starting; the launcher prints the selected address.

## Camera setup cannot find Python

Install **64-bit Python 3.12 or 3.13** with its Windows launcher enabled. Other versions are not selected because the pinned camera dependencies need compatible wheels. To choose a particular interpreter:

```powershell
node scripts/setup-camera.js "C:\Path\To\python.exe"
```

The first setup needs internet access and can take several minutes. If pip fails, check the message above the failure, verify your connection, and retry. Run setup again if you move or remove Python. Close the panel before repairing dependencies.

## Stream offline or reconnecting

On the host, start VRChat and enable **Camera → Stream → Spout Stream**, then select **Start stream** in the panel's Settings. Leave the VRChat camera source on Auto unless you have multiple sources. A viewer cannot start the host's broadcast.

If the stream was intentionally disconnected, start it explicitly. Otherwise the player and receiver retry automatically. If playback struggles, try 1080p30 or 720p in Settings and check upload speed. Each viewer consumes a separate outgoing video stream.

## Video plays but there is no sound

Click the speaker in the player—new viewers start muted. On the host, check the VRChat audio and microphone switches, select the intended microphone, and apply settings. Refresh microphones after connecting a new device. Game audio capture requires VRChat to be running. Microphone capture follows the selected input; it does not capture other apps' desktop audio.

## Avatar controls do nothing

Enable **Action Menu → OSC → Enabled**, wear a published avatar and open Avatar in the panel. Refresh the avatar list if needed. Select the configuration for the avatar you are wearing. Some avatar toggles are sensors, internal state, or overwritten by avatar logic; supported controls vary by creator.

Integer sliders apply when released. Other numeric fields use Set. Feedback under each card shows what VRChat reported, when available. Connection details in Settings can help distinguish packet delivery from avatar behavior.

## A friend cannot open the panel

Keep the server and tunnel running. Save the exact HTTPS URL in **Settings → Sharing & access** before opening it remotely. Use the origin only, such as `https://stream.example.com`, with no extra path. Update it when a temporary tunnel URL changes. Do not rewrite the Host header to bypass the saved-host check.

Check the tunnel provider's traffic/video policies. Quick Cloudflare tunnels do not support the SSE connection used for live updates. This release does not include an Ubuntu relay or an external video service.

## A friend cannot register or control the avatar

Invitations can expire, be revoked, or run out of uses. Create a replacement invitation if needed; existing codes cannot be recovered after the creation dialog closes. New accounts are viewers. An admin can change roles under **Manage accounts & invites**; changed users must sign in again. Admins cannot alter their own permissions.

## I forgot the admin password

Run **Reset Admin Password.cmd** on the host PC and follow the local recovery form. If one active admin exists, it is selected automatically. To choose one explicitly, run `node scripts/reset-admin.js YourUsername`. The recovery form expires after ten minutes. Close it and run the utility again if needed.

There is no default password. Keep the database: deleting it would remove accounts, chat and settings.

## Updating or asking for help

Stop the server, back up **data**, and copy the new source files into the project folder. Retain **data**, **.camera-deps** and **.camera-runtime.json**. Run camera setup again only if dependencies changed or the doctor reports a problem.

When reporting an issue, include your Windows version, `node --version`, the failing step, and the doctor result. Remove passwords, invitation codes, tunnel tokens and private URLs from anything you share. Media is not recorded by the panel.
