#!/usr/bin/env node
/**
 * xfh-doctor: check the Xfinity connection from the command line, without Homebridge.
 * Prints device kinds and states with all secrets redacted.
 *
 *   xfh-doctor --storage /var/lib/homebridge [--watch 60]
 *
 * Uses the saved token file (or the seed token from config.json) and saves any
 * rotated token back, exactly like the plugin. Do not run it while Homebridge is
 * running the plugin: both would rotate the same token.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { TokenStore } from '../api/TokenStore';
import { DEFAULT_ENDPOINTS, XfinityClient } from '../api/XfinityClient';
import { CameraPoller, expandTemplate, parseEventTimes } from '../cameras/CameraPoller';
import { DeviceStore } from '../model/DeviceStore';
import { LEGACY_STORAGE_DIRS, PLATFORM_NAME, PluginConfig, STORAGE_DIR } from '../settings';

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const storage = opt('--storage') ?? '/var/lib/homebridge';
  const watchSec = Number(opt('--watch') ?? 0);

  let cfg: PluginConfig | undefined;
  try {
    const all = JSON.parse(readFileSync(path.join(storage, 'config.json'), 'utf8'));
    cfg = (all.platforms ?? []).find((p: PluginConfig) => p.platform === PLATFORM_NAME);
  } catch {
    // config is optional
  }
  const tokens = new TokenStore(path.join(storage, STORAGE_DIR, 'token.json'), e => console.error('token save failed:', e),
    LEGACY_STORAGE_DIRS.map(d => path.join(storage, d, 'token.json')));
  if (!(await tokens.load(cfg?.refreshToken))) {
    console.error('No refresh token found (token file or config.json).');
    process.exit(1);
  }
  const client = new XfinityClient(tokens, {
    ...DEFAULT_ENDPOINTS,
    ...(cfg?.advanced?.apiBase ? { apiBase: cfg.advanced.apiBase } : {}),
    ...(cfg?.advanced?.oauthUrl ? { oauthUrl: cfg.advanced.oauthUrl } : {}),
  });

  console.log(`API: ${client.endpoints.apiBase}`);
  const profile = await client.getProfile();
  console.log('OK: logged in, token rotated and saved.');
  const linked = profile.sessionInfo?.hasIcontrolAccount ?? profile.xhomeProperties?.hasIcontrolAccount;
  console.log(`Account tier: ${profile.sessionInfo?.accountTier ?? '?'}; security panel linked in cloud: ${linked ?? '?'}\n`);

  const poller = new CameraPoller(client, { info: console.log, warn: console.warn, error: console.error, debug: () => {} });
  const cams = poller.loadProfile(profile.devices);
  for (const c of cams) {
    let ev = 'no events link';
    if (c.eventsTemplate) {
      try {
        const body = await client.fetchSigned(expandTemplate(c.eventsTemplate, new Date(Date.now() - 24 * 3600_000), new Date()), 'json');
        const t = parseEventTimes(body);
        const shape = Array.isArray(body) ? 'array' : body && typeof body === 'object' ? `{${Object.keys(body).join(',')}}` : typeof body;
        ev = `${t.length} recordings in 24h, newest ${t.length ? new Date(Math.max(...t)).toLocaleString() : '-'} (response ${shape})`;
      } catch (e) {
        ev = `events FAILED: ${e instanceof Error ? e.message : e}`;
      }
    }
    let snap: string;
    try {
      const img = await poller.snapshot(c.id);
      snap = `snapshot ${img.length} bytes${img[0] === 0xff && img[1] === 0xd8 ? ' (JPEG)' : ' (NOT a JPEG)'}`;
    } catch (e) {
      snap = `snapshot FAILED: ${e instanceof Error ? e.message : e}`;
    }
    console.log(`camera   ${c.name.padEnd(28)} ${c.model}  ${snap}; ${ev}`);
  }
  if (linked === false) {
    console.log('\nCamera-only account: the panel and sensors are not reachable from the cloud, so they are skipped.');
    return;
  }

  const store = new DeviceStore();
  store.applySnapshot(await client.getDevices());
  for (const d of store.all().filter(x => x.kind !== 'camera')) {
    const bits = d.kind === 'panel' ? `status=${d.panelStatus} armType=${d.armType || '-'}`
      : d.kind === 'light' ? `on=${d.on} level=${d.level ?? '-'}`
        : ['contact', 'motion', 'smoke', 'leak'].includes(d.kind) ? `faulted=${d.faulted} bypassed=${d.bypassed}` : '';
    console.log(`${d.kind.padEnd(8)} ${d.name.padEnd(28)} ${d.online ? 'online ' : 'OFFLINE'} ${bits}` +
      `${d.troubles.length ? ` troubles=${d.troubles.join(',')}` : ''}`);
  }
  if (watchSec > 0) {
    console.log(`\nWatching events for ${watchSec}s (open a door to test)...`);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), watchSec * 1000);
    while (!ctrl.signal.aborted) {
      try {
        for (const ev of await client.waitForDelta(ctrl.signal, 60_000)) {
          const ok = store.applyEvent(ev);
          console.log(`${new Date().toLocaleTimeString()} ${ev.mediaType} ${ev.deviceId ?? 'panel'} ${ev.name ?? ''}=${ev.value ?? ''}` +
            `${ok ? '' : ' (unhandled)'}`);
        }
      } catch (e) {
        if (!ctrl.signal.aborted && !(e instanceof Error && e.name === 'TimeoutError')) {
          console.error('event error:', e instanceof Error ? e.message : e);
          break;
        }
      }
    }
  }
}

main().catch(e => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
