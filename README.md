# homebridge-xfinity-cameras

Bring your **Xfinity Home cameras** into Apple Home: picture tiles, a motion sensor per camera, and a live view
that shows the latest picture, refreshed every second. The plugin also supports the **Xfinity security panel,
door/window, motion, smoke and leak sensors and lights**, on accounts where Comcast's cloud still links the
panel. That part is **experimental** (see [Status](#status)).

> **Unofficial.** This plugin is not made, endorsed or supported by Comcast or Xfinity. It talks to the same
> private service the Xfinity Home app uses, which Comcast can change at any time. Use it at your own risk.

## Status

| Feature | Status |
|---|---|
| Camera tiles (snapshots) | **Working**: tested on a real account with two xCam2 (SCHC2AEW) cameras |
| Camera motion sensors | **Working**: motion turns on when a camera records a new clip |
| Camera live view | **Working as a picture stream**: the latest picture, refreshed every second. Not continuous video (see [Live view](#live-view)) |
| Security panel (arm/disarm), sensors, lights | **Experimental**: rebuilt from the original plugin and tested against a simulated server only, because the author's account no longer has a panel linked in Comcast's cloud. If you have a linked panel, please try it and [open an issue](https://github.com/thatboyjonny/homebridge-xfinity-cameras/issues) with your results |

### Why the panel may not show up

Some Xfinity accounts, especially after the move to the newer Xfinity app and "self-protection" plans, no longer
link the security panel in Comcast's cloud. The touchscreen and sensors keep working at home, but no app or
plugin can reach them over the internet. The plugin detects this (the account profile reports
`hasIcontrolAccount: false`) and runs in **camera-only mode**. It logs:

```
Comcast reports no security panel linked to this Xfinity account in the cloud ... Running in camera-only mode.
```

That isn't a bug in the plugin; there is nothing in the cloud to connect to.

## Requirements

- Homebridge 1.8 or 2.x, Node.js 20, 22 or 24
- An Xfinity Home account with cameras, and a **refresh token** from the Xfinity Home app (see [Getting a token](#getting-a-token))
- For live view: **ffmpeg** with libx264 and SRTP on the Homebridge machine. On Debian, Ubuntu or Raspberry Pi OS run
  `sudo apt install ffmpeg`. Without it, tiles and motion still work, and opening a camera shows "No Response".

## Install

1. In the Homebridge UI, go to **Plugins**, search for **Xfinity Cameras**, and install it.
   Or run `npm install -g homebridge-xfinity-cameras`.
2. Open the plugin's **Settings**, paste your **refresh token**, and save.
3. Restart Homebridge.
4. **Add each camera to Apple Home.** Cameras are published as their own accessories, not inside the
   Homebridge bridge, because Apple Home often never asks bridged cameras for pictures. In the Home app, tap
   **+ → Add Accessory → More options…**, pick the camera, and enter your Homebridge PIN. Do this once per camera.

If you have a linked panel, sensors and lights appear through the bridge on their own.

## Getting a token

The plugin signs in with a **refresh token** from the **Xfinity Home** app. You copy it once, and the plugin
keeps it fresh from then on: Xfinity issues a new token on every refresh, and the plugin saves each new one in
its own storage folder.

You capture the token with a debugging proxy such as Proxyman on your iPhone. It takes about 15 minutes, and
[CAPTURE.md](CAPTURE.md) has step-by-step instructions, including cleaning up afterwards.

Paste the token only into the plugin's settings, and never into an issue, chat or log. Anyone with it can sign in
to your Xfinity Home account.

## Live view

Opening a camera in Apple Home streams its **latest picture** as video, refreshed every second by default. It's
tested on the home network. Away from home, Apple routes the stream through your home hub, as it does for other
Homebridge cameras. Reports either way are welcome.

It isn't continuous video because Comcast's live video uses its own WebRTC setup, which Apple Home can't play
directly. The picture can only change as often as Comcast updates it. After each viewing the plugin logs how
often that was:

```
Driveway: live view ended (viewer closed it): 31 s watched, 30 pictures fetched, picture changed 29 times (about every 1 s).
```

Continuous video would need a WebRTC bridge (like the one homebridge-ring uses). Contributions welcome.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Refresh token (seed) | | Needed once. After the first successful start you can clear it. Paste a new one only if the log says Xfinity rejected the token |
| Cameras | on | Adds cameras with snapshots and motion |
| Camera motion stays on for | 30 s | |
| Check cameras for new motion every | 30 s | Minimum 15 s |
| Live view | on | Needs ffmpeg |
| Live view picture refresh | 1 s | Lower is smoother, if Comcast's picture changes that fast |
| ffmpeg path | `ffmpeg` | Set it if ffmpeg isn't on the PATH |
| Hide devices | | Device names or ids to leave out, cameras included |
| Keypad PIN | | *(panel)* Needed to arm and disarm from Apple Home. Blank means read-only |
| Apple Home "Night" arms as | night | *(panel)* `night`, `stay`, or hide Night |
| Show entry delay as Triggered | on | *(panel)* |
| Temperature sensors | off | *(panel)* Temperature readings from door and motion sensors |
| Advanced | | *(panel)* Refresh interval (300 s), event stream on/off, endpoint overrides |

## How it works

- **Sign-in:** OAuth refresh-token rotation against `oauth.xfinity.com`, as the Xfinity Home app does it. The
  latest token is saved atomically in `<homebridge storage>/xfinity-cameras/token.json` (file mode 600), and the
  token is never written to the log.
- **Cameras:** the account profile (`/client`) lists the cameras.
  - Snapshots come from the pre-signed thumbnail links in `/client/nextgenThumbnails`. If those fail, the plugin
    falls back to the still from the newest recording.
  - Motion comes from polling each camera's recorded-clip list.
  - Media links are only fetched over HTTPS from Comcast hosts (`*.comcast.net`, `*.comcast.com`).
- **Panel and sensors (experimental):** the plugin keeps a device list plus a long-poll event stream, and Apple
  Home reads are answered from memory.
  - Arming is reported to Apple Home only once the panel confirms it.
  - The plugin refuses to arm while a sensor is open, and names the open sensor.
  - A wrong PIN or a failed command puts the target state back.
- **Privacy:** no analytics or tracking. The plugin only contacts Xfinity and Comcast servers.

## Troubleshooting

- **"Xfinity rejected the refresh token"**: the token chain was broken. This happens if you signed out of the
  app, or if the app refreshed the same token. Capture a new token ([CAPTURE.md](CAPTURE.md)) and paste it into
  the settings.
- **Camera says "No Response" on the tile**: check that you added the camera itself to Apple Home (step 4 of
  [Install](#install)), not just the bridge. The log should show `Apple Home asked for a picture` when the Home
  app opens.
- **Opening a camera says "No Response"**: live view needs ffmpeg. Look for `Camera live view: on` or the reason
  it's off near the start of the log.
- **Command-line check:** `xfh-doctor --storage /var/lib/homebridge` signs in, prints the account mode, and tests
  a snapshot and the recordings list for each camera. Its output contains no tokens. **Stop Homebridge first**,
  because the doctor and the plugin share the same token chain.

When reporting a bug, include the plugin's log lines and the `xfh-doctor` output, and never your token or PIN.

## Development

```bash
npm install
npm test     # unit tests, plus end-to-end tests with real HAP-NodeJS against a simulated Xfinity server
```

The camera live-view tests run real ffmpeg when it's installed.

## Credits and license

Based on [homebridge-xfinityhome](https://github.com/bloomkd46/homebridge-XfinityHome) and
[xfinityhome](https://www.npmjs.com/package/xfinityhome) by Kolton Bloom (bloomkd46), Apache-2.0. The camera
stream setup follows the pattern used by [homebridge-ring](https://github.com/dgreif/ring).

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
