import { EventEmitter } from 'node:events';

import type { RawDevice } from '../api/types';
import type { XfinityClient } from '../api/XfinityClient';
import type { Log } from '../sync/SyncEngine';

export interface CameraInfo {
  id: string;
  hardwareId: string;
  name: string;
  mac?: string;
  model: string;
  serial: string;
  firmware: string;
  /** templated, pre-signed CVR events URL from the profile; refreshed with the profile */
  eventsTemplate?: string;
}

export interface PollerOptions {
  motionPollMs: number;
  profileRefreshMs: number;
  /** how far back each events query looks */
  lookbackMs: number;
}

export const DEFAULT_POLLER: PollerOptions = { motionPollMs: 30_000, profileRefreshMs: 10 * 60_000, lookbackMs: 15 * 60_000 };

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Expand the RFC 6570 subset Comcast uses: `{start}` and `{&end}`. The format matches
 * what the Xfinity app sends to the sibling events/v2 endpoint (ISO 8601, whole seconds, Z).
 */
export type DateFormat = 'iso' | 'ms';

export function expandTemplate(template: string, start: Date, end?: Date, fmt: DateFormat = 'iso'): string {
  const f = (d: Date) => encodeURIComponent(fmt === 'ms' ? String(d.getTime()) : isoSec(d));
  return template
    .replace(/\{&end\}/g, end ? `&end=${f(end)}` : '')
    .replace(/\{&[^}]*\}/g, '')
    .replace(/\{start\}/g, f(start));
}

/** Pull event start times (epoch ms) out of whatever shape the CVR events endpoint returns. */
export function parseEventTimes(body: unknown): number[] {
  const list: unknown[] = Array.isArray(body) ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).events ?? (body as Record<string, unknown>).data ?? []) as unknown[]
      : [];
  const out: number[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') {
      continue;
    }
    const r = e as Record<string, unknown>;
    const v = r.startTime ?? r.start ?? r.eventTime ?? r.timestamp ?? r.time;
    let t = NaN;
    if (typeof v === 'number') {
      t = v < 1e12 ? v * 1000 : v;
    } else if (typeof v === 'string') {
      t = /^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : Date.parse(v);
    }
    if (Number.isFinite(t)) {
      out.push(t);
    }
  }
  return out;
}

/** The thumbnail link of the newest recording, in the shapes Comcast uses (events/v2: links[{type:'thumbnail'}]). */
export function newestThumbnail(body: unknown): string | undefined {
  const list: unknown[] = Array.isArray(body) ? body
    : body && typeof body === 'object' ? ((body as Record<string, unknown>).events ?? (body as Record<string, unknown>).data ?? []) as unknown[]
      : [];
  let best: { t: number; href: string } | undefined;
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') {
      continue;
    }
    const r = e as Record<string, unknown>;
    const t = parseEventTimes([r])[0] ?? 0;
    let href: unknown;
    if (Array.isArray(r.links)) {
      href = (r.links as Array<Record<string, unknown>>).find(l => l && /thumb|image|snapshot/i.test(String(l.type ?? l.rel ?? '')))?.href;
    }
    const nested = (r._links ?? {}) as Record<string, { href?: string } | undefined>;
    href ??= nested.thumbnail?.href ?? nested.image?.href ?? r.thumbnailUrl ?? r.thumbnail;
    if (typeof href === 'string' && /^https:\/\//.test(href) && (!best || t > best.t)) {
      best = { t, href: href.replace(/\{[^}]*\}/g, '') };
    }
  }
  return best?.href;
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const describe = (b: Buffer) => {
  const head = b.subarray(0, 1).toString();
  return `not a JPEG (${b.length} bytes${head === '{' || head === '[' ? ', looks like JSON' : head === '<' ? ', looks like HTML' : ''})`;
};

export function camerasFromProfile(devices: RawDevice[] = []): CameraInfo[] {
  return devices.filter(d => d.deviceType === 'camera').map(d => {
    const links = (d._links ?? {}) as Record<string, { href?: string } | undefined>;
    const events = links.cvrEvents?.href;
    const rawMac = typeof d.macAddress === 'string' ? d.macAddress : '';
    const mac = (events?.match(/\/camera\/([0-9A-Fa-f]{12})\//)?.[1] ?? rawMac.replace(/[^0-9A-Fa-f]/g, ''))
      .toUpperCase() || undefined;
    const p = d.properties ?? {};
    return {
      id: d.id,
      hardwareId: d.hardwareId ?? d.id,
      name: String(p.label ?? d.name ?? 'Camera').trim() || 'Camera',
      mac,
      model: d.model ?? 'xCam',
      serial: d.serialNumber ?? d.id,
      firmware: d.firmwareVersion ?? '0',
      eventsTemplate: events,
    };
  });
}

interface PollerEvents {
  motion: [cameraId: string, at: number];
  cameras: [cameras: CameraInfo[]];
}

/**
 * Cameras on accounts without an iControl (panel) account: there is no event stream,
 * so motion comes from polling each camera's recorded-event (CVR) list, and snapshots
 * come from the pre-signed thumbnail URLs.
 */
export class CameraPoller extends EventEmitter<PollerEvents> {
  cameras = new Map<string, CameraInfo>();
  private lastSeen = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private lastProfile = 0;
  private thumbs?: { at: number; byMac: Map<string, string> };
  private snapCache = new Map<string, { at: number; img: Buffer }>();
  private running = false;
  private warned = 0;
  private lastOk = 0;
  private startedAt = 0;
  private dateFmt?: DateFormat;
  private announced = '';
  private recentThumb = new Map<string, string>();
  /** live thumbnails failed recently: go straight to the last-recording still until this time */
  private liveBrokenUntil = 0;
  private snapSource = '';
  private snapWarned = 0;

  constructor(
    private readonly client: XfinityClient,
    private readonly log: Log,
    private readonly opts: PollerOptions = DEFAULT_POLLER,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /** Load cameras from an already-fetched profile. */
  loadProfile(devices: RawDevice[] | undefined): CameraInfo[] {
    const list = camerasFromProfile(devices);
    this.cameras = new Map(list.map(c => [c.id, c]));
    this.lastProfile = this.now();
    this.emit('cameras', list);
    return list;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.startedAt = this.now();
    this.tick().catch(err => this.log.error(`Xfinity camera poller stopped: ${err instanceof Error ? err.message : err}`));
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.running) {
      this.timer = setTimeout(() => {
        this.tick().catch(err => this.log.error(`Xfinity camera poller stopped: ${err instanceof Error ? err.message : err}`));
      }, this.opts.motionPollMs);
    }
  }

  private async tick(): Promise<void> {
    await this.poll();
    this.schedule();
  }

  /** One poll: refresh the profile when due, then check every camera for new recordings. */
  async poll(): Promise<void> {
    try {
      if (this.now() - this.lastProfile > this.opts.profileRefreshMs) {
        this.loadProfile((await this.client.getProfile()).devices);
      }
      await Promise.all([...this.cameras.values()].map(c => this.checkMotion(c)));
      this.lastOk = this.now();
    } catch (err) {
      this.warn(`camera poll failed: ${err instanceof Error ? err.message : err}`);
      this.lastProfile = 0; // signed URLs may have expired; refresh next time
    }
  }

  private async checkMotion(cam: CameraInfo): Promise<void> {
    if (!cam.eventsTemplate) {
      return;
    }
    // first query looks back a day so the last-recording snapshot fallback has a picture right away
    const first = !this.lastSeen.has(cam.id);
    const start = new Date(this.now() - (first ? 24 * 3600_000 : this.opts.lookbackMs));
    const end = new Date(this.now() + 60_000);
    const formats: DateFormat[] = this.dateFmt ? [this.dateFmt] : ['iso', 'ms'];
    let times: number[] | undefined;
    const errors: string[] = [];
    for (const fmt of formats) {
      const url = expandTemplate(cam.eventsTemplate, start, end, fmt);
      try {
        const body = await this.client.fetchSigned(url, 'json');
        times = parseEventTimes(body);
        const thumb = newestThumbnail(body);
        if (thumb) {
          this.recentThumb.set(cam.id, thumb);
        }
        this.dateFmt = fmt;
        this.announce(new URL(url).hostname, fmt);
        break;
      } catch (err) {
        errors.push(`${fmt} dates: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!times) {
      this.lastProfile = 0;
      throw new Error(errors.join(' | '));
    }
    const newest = times.length ? Math.max(...times) : 0;
    const prev = this.lastSeen.get(cam.id);
    if (prev === undefined) {
      this.lastSeen.set(cam.id, newest || this.now()); // prime: don't fire on startup
      return;
    }
    if (newest > prev) {
      this.lastSeen.set(cam.id, newest);
      this.emit('motion', cam.id, newest);
    }
  }

  /** Motion data is trustworthy if a poll succeeded recently (10 polls or 5 min). */
  isFresh(): boolean {
    if (!this.lastOk) {
      // just started: report "no motion" rather than No Response while the first poll runs,
      // so Apple Home doesn't mark the camera unreachable at every Homebridge restart
      return this.startedAt > 0 && this.now() - this.startedAt < 3 * 60_000;
    }
    return this.now() - this.lastOk < Math.max(5 * 60_000, this.opts.motionPollMs * 10);
  }

  /**
   * JPEG snapshot for a camera, cached briefly so HomeKit tile refreshes don't hammer Comcast.
   * Source 1: the live thumbnail (/client/nextgenThumbnails). Source 2 (fallback): the still of
   * the newest recording from the events list, served by the same host the motion check uses.
   */
  async snapshot(cameraId: string, maxAgeMs = 4_000): Promise<Buffer> {
    const cam = this.cameras.get(cameraId);
    if (!cam?.mac) {
      throw new Error('unknown camera');
    }
    const cached = this.snapCache.get(cameraId);
    if (cached && this.now() - cached.at < maxAgeMs) { // tiles: 4 s; live view asks for fresher
      return cached.img;
    }
    const errors: string[] = [];
    let img: Buffer | undefined;
    if (this.now() >= this.liveBrokenUntil) {
      try {
        img = await this.liveSnapshot(cam);
        this.noteSource(cam, 'live picture');
      } catch (err) {
        errors.push(`live picture: ${err instanceof Error ? err.message : err}`);
        this.liveBrokenUntil = this.now() + 10 * 60_000;
      }
    }
    if (!img) {
      const url = this.recentThumb.get(cam.id);
      if (url) {
        try {
          const b = await this.client.fetchSigned(url, 'buffer', 6_000) as Buffer;
          if (!isJpeg(b)) {
            throw new Error(describe(b));
          }
          img = b;
          this.noteSource(cam, 'still from the latest recording', errors[0]);
        } catch (err) {
          errors.push(`latest recording still: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        errors.push('latest recording still: no recordings with a picture yet');
      }
    }
    if (!img) {
      const msg = `snapshot for "${cam.name}" failed: ${errors.join(' | ')}`;
      if (this.now() - this.snapWarned > 10 * 60_000) {
        this.snapWarned = this.now();
        this.log.warn(`Xfinity ${msg}`);
      } else {
        this.log.debug(`Xfinity ${msg}`);
      }
      throw new Error(msg);
    }
    this.snapCache.set(cameraId, { at: this.now(), img });
    return img;
  }

  private async liveSnapshot(cam: CameraInfo): Promise<Buffer> {
    let fetchedList = false;
    const get = async (fresh: boolean) => {
      if (fresh || !this.thumbs || this.now() - this.thumbs.at > 60_000) {
        fetchedList = true;
        const list = await this.client.getThumbnails();
        this.thumbs = { at: this.now(), byMac: new Map(list.map(t => [String(t.cameraMac).replace(/[^0-9A-Fa-f]/g, '').toUpperCase(), t.url])) };
      }
      const url = this.thumbs.byMac.get(cam.mac!);
      if (!url) {
        throw new Error(`no thumbnail URL for this camera (Comcast listed ${this.thumbs.byMac.size})`);
      }
      const b = await this.client.fetchSigned(url, 'buffer', 6_000) as Buffer;
      if (!isJpeg(b)) {
        throw new Error(describe(b));
      }
      return b;
    };
    try {
      return await get(false);
    } catch (err) {
      if (fetchedList) {
        throw err; // the list was fetched for this request; retrying won't help
      }
      return get(true); // signed URL expired: fetch fresh ones once
    }
  }

  private noteSource(cam: CameraInfo, source: string, why?: string): void {
    if (source !== this.snapSource) {
      this.snapSource = source;
      this.log.info(`Xfinity camera snapshots: using the ${source} (first seen on "${cam.name}")` +
        `${why ? `; ${why}` : ''}.`);
    }
  }

  /** Log once (info) how the events host was reached, so a working setup is visible in the log. */
  private announce(host: string, fmt: DateFormat): void {
    const how = `${this.client.signedAuth.get(host) ?? '?'}/${fmt}`;
    if (how !== this.announced) {
      this.announced = how;
      const auth = { 'none': 'signed link only', 'bearer': 'signed link + app token', 'bearer+session': 'signed link + app session' }[
        this.client.signedAuth.get(host) ?? 'none'];
      this.log.info(`Xfinity camera motion: recordings list reachable (${auth}, ${fmt === 'iso' ? 'ISO' : 'epoch'} dates).`);
    }
  }

  private warn(msg: string): void {
    if (this.now() - this.warned > 10 * 60_000) {
      this.warned = this.now();
      this.log.warn(`Xfinity ${msg} (will keep retrying)`);
    } else {
      this.log.debug(`Xfinity ${msg}`);
    }
  }
}
