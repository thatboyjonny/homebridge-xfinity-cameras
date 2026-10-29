import path from 'node:path';

import type { API, Categories, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { BaseAccessory } from './accessories/BaseAccessory';
import { CameraAccessory } from './accessories/CameraAccessory';
import { LightAccessory } from './accessories/LightAccessory';
import { PanelAccessory } from './accessories/PanelAccessory';
import { SensorAccessory } from './accessories/SensorAccessory';
import { TokenStore } from './api/TokenStore';
import type { ClientProfile } from './api/types';
import { AuthRejectedError, DEFAULT_ENDPOINTS, XfinityClient } from './api/XfinityClient';
import { CameraInfo, CameraPoller, DEFAULT_POLLER } from './cameras/CameraPoller';
import { checkFfmpeg, DEFAULT_SLIDESHOW } from './cameras/SlideshowStream';
import type { LiveViewConfig } from './accessories/CameraAccessory';
import { DeviceStore } from './model/DeviceStore';
import type { DeviceState } from './model/normalize';
import { safeName } from './model/normalize';
import { AccessoryContext, LEGACY_STORAGE_DIRS, PLATFORM_NAME, PLUGIN_NAME, PluginConfig, STORAGE_DIR } from './settings';
import { DEFAULT_SYNC, SyncEngine } from './sync/SyncEngine';
import { backoffMs, sleep } from './util/backoff';

const SUPPORTED = new Set(['panel', 'contact', 'motion', 'smoke', 'leak', 'light']);

export class XfinityPlatform implements DynamicPlatformPlugin {
  readonly config: PluginConfig;
  readonly store = new DeviceStore();
  readonly tokens: TokenStore;
  readonly client: XfinityClient;
  readonly sync: SyncEngine;
  readonly cameras: CameraPoller;
  /** false when Comcast's cloud has no security-panel (iControl) account linked */
  panelMode = true;

  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly handlers = new Map<string, BaseAccessory>();
  private reconciled = false;
  private readonly cameraHandlers = new Map<string, CameraAccessory>();
  private readonly stopping = new AbortController();
  private liveView?: LiveViewConfig;

  constructor(readonly log: Logging, config: PlatformConfig, readonly api: API) {
    this.config = config as unknown as PluginConfig;
    const tokenFile = path.join(api.user.storagePath(), STORAGE_DIR, 'token.json');
    const legacy = LEGACY_STORAGE_DIRS.map(d => path.join(api.user.storagePath(), d, 'token.json'));
    this.tokens = new TokenStore(tokenFile, err => log.error('Could not save the rotated Xfinity token:', String(err)), legacy);
    this.client = new XfinityClient(this.tokens, {
      ...DEFAULT_ENDPOINTS,
      ...(this.config.advanced?.apiBase ? { apiBase: this.config.advanced.apiBase } : {}),
      ...(this.config.advanced?.oauthUrl ? { oauthUrl: this.config.advanced.oauthUrl } : {}),
    });
    this.sync = new SyncEngine(this.client, this.store, log, {
      ...DEFAULT_SYNC,
      refreshIntervalMs: Math.max(60, this.config.refreshIntervalSeconds ?? 300) * 1000,
      useEvents: this.config.useEventStream !== false,
    });

    this.cameras = new CameraPoller(this.client, log, {
      ...DEFAULT_POLLER,
      motionPollMs: Math.min(600, Math.max(15, this.config.cameraPollSeconds ?? 30)) * 1000,
    });

    this.store.on('change', (s, prev) => {
      if (!prev && this.reconciled) {
        this.ensureAccessory(s); // a device was added to the Xfinity system later
      }
    });

    api.on('didFinishLaunching', () => {
      this.launch().catch(err => this.log.error(`Xfinity start-up failed: ${err instanceof Error ? err.message : err}`));
    });
    api.on('shutdown', () => {
      this.stopping.abort();
      this.sync.stop();
      this.cameras.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private async launch(): Promise<void> {
    const token = await this.tokens.load(this.config.refreshToken);
    if (!token) {
      this.log.warn('No refresh token yet: add one in the plugin settings (see the README, "Getting a token"). Not starting.');
      return;
    }
    this.log.info('Connecting to Xfinity…');
    const profile = await this.firstProfile();
    if (!profile) {
      return; // shutting down
    }
    const linked = profile.sessionInfo?.hasIcontrolAccount ?? profile.xhomeProperties?.hasIcontrolAccount;
    this.panelMode = linked !== false;
    if (this.panelMode) {
      await this.sync.start();
      if (this.stopping.signal.aborted) {
        return;
      }
    } else {
      this.log.info('Comcast reports no security panel linked to this Xfinity account in the cloud, so the panel and ' +
        'sensors can\'t be reached from here (they keep working on the touchscreen). Running in camera-only mode.');
    }
    const keep = new Set<string>();
    if (this.config.cameras !== false) {
      for (const cam of this.cameras.loadProfile(profile.devices)) {
        const uuid = this.ensureCamera(cam);
        if (uuid) {
          keep.add(uuid);
        }
      }
      if (this.cameras.cameras.size) {
        this.cameras.start();
      }
    }
    this.reconcile(keep);
  }

  /** Fetch the account profile, retrying with backoff until it works or Homebridge stops. */
  private async firstProfile(): Promise<ClientProfile | undefined> {
    for (let attempt = 0; !this.stopping.signal.aborted; attempt++) {
      try {
        return await this.client.getProfile();
      } catch (err) {
        const wait = err instanceof AuthRejectedError ? 30 * 60_000 : backoffMs(attempt);
        this.log.warn(`Could not reach Xfinity (${err instanceof Error ? err.message : err}); ` +
          `retrying in ${Math.round(wait / 1000)}s.`);
        await sleep(wait, this.stopping.signal);
      }
    }
    return undefined;
  }

  /** Decide once whether the slideshow live view can run (setting on + usable ffmpeg). */
  private liveViewConfig(): LiveViewConfig {
    if (this.liveView) {
      return this.liveView;
    }
    if (this.config.liveView === false) {
      this.liveView = { slideshow: null, offReason: 'turned off in settings' };
    } else {
      const ffmpegPath = this.config.ffmpegPath?.trim() || 'ffmpeg';
      const check = checkFfmpeg(ffmpegPath);
      if (check.ok) {
        this.liveView = { slideshow: { ...DEFAULT_SLIDESHOW, ffmpegPath,
          refreshMs: Math.min(60, Math.max(1, this.config.liveViewRefreshSeconds ?? 1)) * 1000 } };
        this.log.info('Camera live view: on (opening a camera shows its latest picture, refreshed every ' +
          `${this.liveView.slideshow!.refreshMs / 1000} s).`);
      } else {
        this.liveView = { slideshow: null, offReason: check.reason };
        this.log.warn(`Camera live view is off: ${check.reason}. Install ffmpeg on the Homebridge machine ` +
          '(e.g. "apt install ffmpeg") and restart; tiles and motion still work.');
      }
    }
    return this.liveView;
  }

  private ensureCamera(cam: CameraInfo): string | undefined {
    if (this.hiddenName(cam.name, cam.id)) {
      return undefined;
    }
    if (!cam.mac) {
      this.log.warn(`Camera "${safeName(cam.name)}" has no recording/snapshot links in the Xfinity profile; skipping.`);
      return undefined;
    }
    // Cameras are published as their own HomeKit accessories (not inside the bridge): Apple Home
    // often never sends snapshot/stream requests to bridged cameras. A new UUID namespace means any
    // old bridged copy from 0.2.0-0.2.3 is not kept and gets removed by reconcile().
    const uuid = this.api.hap.uuid.generate(`xfinityhome-camera:${cam.hardwareId}`);
    if (this.cameraHandlers.has(uuid)) {
      return uuid;
    }
    const acc = new this.api.platformAccessory<AccessoryContext>(safeName(cam.name), uuid, this.api.hap.Categories.IP_CAMERA);
    acc.context = { deviceId: cam.id, kind: 'camera' };
    try {
      this.cameraHandlers.set(uuid, new CameraAccessory(this.api, acc, cam, this.cameras,
        (level, msg) => this.log[level](`${safeName(cam.name)}: ${msg}`),
        Math.min(600, Math.max(5, this.config.cameraMotionSeconds ?? 30)), this.liveViewConfig()));
    } catch (err) {
      this.log.error(`Could not set up camera "${cam.name}": ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
    this.api.publishExternalAccessories(PLUGIN_NAME, [acc]);
    this.log.info(`Camera "${safeName(cam.name)}" published as its own accessory (snapshots + motion). If it isn't ` +
      'in Apple Home yet: Home app > + > Add Accessory > More options, pick it, and enter your Homebridge PIN.');
    return uuid;
  }

  /** Create/restore accessories for current devices; drop cached ones that no longer exist. */
  private reconcile(keep: Set<string>): void {
    const counts: Record<string, number> = { camera: keep.size };
    for (const s of this.store.all()) {
      if (s.kind === 'camera') {
        continue; // handled by the camera poller
      }
      counts[s.kind] = (counts[s.kind] ?? 0) + 1;
      const acc = this.ensureAccessory(s);
      if (acc) {
        keep.add(acc.UUID);
      }
      if (s.kind === 'unknown') {
        this.log.debug(`Skipping unsupported device "${s.name}" (${s.model}).`);
      }
    }
    const stale = [...this.cached.values()].filter(a => !keep.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessories that are no longer in your Xfinity system.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach(a => this.cached.delete(a.UUID));
    }
    this.reconciled = true;
    this.log.info('Xfinity devices: ' + Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', '));
  }

  private hidden(s: DeviceState): boolean {
    return this.hiddenName(s.name, s.id);
  }

  private hiddenName(name: string, id: string): boolean {
    const list = (this.config.hideDevices ?? []).map(x => x.trim().toLowerCase());
    return list.includes(name.toLowerCase()) || list.includes(id.toLowerCase());
  }

  private ensureAccessory(s: DeviceState): PlatformAccessory<AccessoryContext> | undefined {
    if (!SUPPORTED.has(s.kind) || this.hidden(s)) {
      return undefined;
    }
    const uuid = this.api.hap.uuid.generate(`xfinityhome:${s.hardwareId}`);
    if (this.handlers.has(uuid)) {
      return this.cached.get(uuid);
    }
    let acc = this.cached.get(uuid);
    const isNew = !acc;
    if (!acc) {
      acc = new this.api.platformAccessory<AccessoryContext>(safeName(s.name), uuid, category(this.api, s));
      this.cached.set(uuid, acc);
    }
    acc.context = { deviceId: s.id, kind: s.kind };
    try {
      const handler = s.kind === 'panel' ? new PanelAccessory(this, acc, s)
        : s.kind === 'light' ? new LightAccessory(this, acc, s)
          : new SensorAccessory(this, acc, s);
      this.handlers.set(uuid, handler);
    } catch (err) {
      this.log.error(`Could not set up "${s.name}": ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
    if (isNew) {
      this.log.info(`Adding ${s.kind} "${safeName(s.name)}"`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    } else {
      this.api.updatePlatformAccessories([acc]);
    }
    return acc;
  }
}

function category(api: API, s: DeviceState): Categories {
  switch (s.kind) {
    case 'panel': return api.hap.Categories.SECURITY_SYSTEM;
    case 'light': return api.hap.Categories.LIGHTBULB;
    case 'contact':
      return s.subtype === 'window' ? api.hap.Categories.WINDOW
        : s.subtype === 'door' ? api.hap.Categories.DOOR : api.hap.Categories.SENSOR;
    default: return api.hap.Categories.SENSOR;
  }
}
