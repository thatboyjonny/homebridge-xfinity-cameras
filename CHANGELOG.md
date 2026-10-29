# Changelog

## 1.0.0 (2026-10-29)

First public release, as a ground-up rebuild of
[homebridge-xfinityhome](https://github.com/bloomkd46/homebridge-XfinityHome) 3.6.2.

### Cameras (tested on a real account)
- **Cameras as their own accessories:** each Xfinity camera is published as its own Apple Home accessory,
  because Apple Home often never asks bridged cameras for pictures.
- **Snapshots:** taken from Comcast's live thumbnails, with a fallback to the still from the newest recording.
- **Motion sensors:** motion turns on when a camera records a new clip. Both the poll interval and how long
  motion stays on are adjustable.
- **Live view:** streams the latest picture as H.264 over SRTP using ffmpeg, refreshed every second by
  default. After each viewing the log reports how often the picture really changed.
- **Camera-only mode:** used for accounts where Comcast's cloud no longer links the security panel
  (`hasIcontrolAccount: false`).
- **Signed media links:** fetched only over HTTPS from Comcast hosts. If a host rejects the bare link, the
  plugin retries with the app's credentials and remembers what worked.

### Panel, sensors and lights (experimental)
- **Answers from memory:** Apple Home reads are answered from an in-memory store, kept current by the device
  list and the event stream.
- **Confirmed arming:** the target state is held as pending until the panel confirms it. The plugin refuses
  to arm while a sensor is open and names it. A wrong PIN or a failed command puts the target state back.
- **"No Response" on stale data:** shown when data is older than 3 refresh intervals (minimum 15 minutes).

### Sign-in and reliability
- **Token rotation:** the newest refresh token is saved atomically, never logged, and survives restarts.
  Pasting a new token in the settings starts a fresh chain.
- **Retries:** jittered backoff on every network loop, so a single failure never stops the plugin.
- **Settings:** a plain settings form with no remote scripts and no proxy tool.
- **Diagnostics:** an `xfh-doctor` command-line check and a HAR scrubber for sharing captures safely.
