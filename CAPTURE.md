# Getting your Xfinity refresh token (about 15 minutes)

The plugin needs one **refresh token** from the **Xfinity Home** app. The app gets that token when you sign in.
To see it, you briefly route your iPhone's traffic through a debugging proxy (these steps use
[Proxyman](https://proxyman.io)), copy the token, then remove the proxy.

**Before you start:**
- While the proxy's certificate is trusted, the proxy can read your phone's encrypted traffic. Do this in one
  sitting, and finish the cleanup in step 5.
- The token gives access to your Xfinity Home account. Paste it only into the plugin's settings, and never
  into an issue, a chat or a screenshot.

## 1. Set up Proxyman

You can use the iPhone app on its own, or the Mac app with your iPhone pointed at your Mac.

1. Install **Proxyman** and follow its iPhone setup: allow the **VPN** configuration (iPhone app), or set your
   iPhone's Wi-Fi proxy to your Mac (Mac app). Then **install the certificate**.
2. On the iPhone, open **Settings → General → About → Certificate Trust Settings** and turn on full trust for the
   Proxyman certificate.
3. In Proxyman, enable **SSL Proxying** for `oauth.xfinity.com`. A wildcard such as `*.xfinity.com` also works.
4. Start capturing.

## 2. Sign in to the Xfinity Home app

1. Open **Xfinity Home**. If you're already signed in, sign out (**More → Sign Out**).
2. Sign in again, completing two-factor verification if asked.
3. Let the home screen load.

## 3. Copy the token

1. In Proxyman, find the **newest** request named `POST https://oauth.xfinity.com/oauth/token`.
2. Open the **Response** pane, then the **Body** tab. Use **Treeview** if the body is all on one line.
3. Copy the value of **`refresh_token`**.
4. In Homebridge, open **Plugins → Xfinity Cameras → Settings**, paste it into **Refresh token (seed)**, then
   **Save** and restart Homebridge.

The log should show the plugin connecting and adding your cameras.

## 4. Keep the app from breaking the plugin's token

The app and the plugin now share one token chain. If the app refreshes it, or you sign out of the app, the
plugin's token stops working. Right after copying the token:

- **Delete the Xfinity Home app from your iPhone without signing out.** Signing out revokes the token.
- Use the regular **Xfinity** app for day-to-day camera viewing.
- If you reinstall Xfinity Home later and sign in, that's a new sign-in. If the plugin then reports the token
  was rejected, capture a new token (steps 2–3).

## 5. Clean up (important)

1. Stop capturing in Proxyman.
2. On the iPhone:
   - Under **Settings → General → About → Certificate Trust Settings**, turn the Proxyman certificate **off**.
   - Under **Settings → General → VPN & Device Management**, remove the Proxyman profile and VPN.
   - If you set a Wi-Fi proxy, turn it **off** under **Settings → Wi-Fi → (i) → Configure Proxy**.
3. On a Mac, quit Proxyman and delete the Proxyman certificate in **Keychain Access**.
4. Delete Proxyman if you won't use it again.

## Helping with panel and sensor support (optional)

If your account still has a linked security panel and something doesn't work, a scrubbed capture of the app
helps. Capture while you arm and disarm, open and close a door, and walk past a motion sensor. Then export a HAR
file and scrub it on your computer:

```bash
node tools/har-scrub.mjs xfinity.har xfinity-scrubbed.har
```

The scrubber masks tokens, cookies, session headers, PINs, email, address, phone and public IPs, and drops
images and video. **Read the scrubbed file yourself before sharing it**, and attach only the scrubbed file to the
issue.
