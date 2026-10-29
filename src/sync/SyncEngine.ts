import { AuthRejectedError, XfinityClient } from '../api/XfinityClient';
import type { DeltaEvent } from '../api/types';
import { DeviceStore } from '../model/DeviceStore';
import { backoffMs, sleep } from '../util/backoff';

export interface Log {
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
  debug(msg: string, ...a: unknown[]): void;
}

export interface SyncOptions {
  /** full device-list refresh interval; also the fallback if the event stream dies */
  refreshIntervalMs: number;
  /** how long one delta long-poll may hang before we re-issue it */
  deltaTimeoutMs: number;
  /** disable the event stream entirely and rely on polling */
  useEvents: boolean;
  /** retry interval while the refresh token is rejected */
  authRetryMs: number;
}

export const DEFAULT_SYNC: SyncOptions = {
  refreshIntervalMs: 5 * 60_000,
  deltaTimeoutMs: 2 * 60_000,
  useEvents: true,
  authRetryMs: 30 * 60_000,
};

const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/**
 * Keeps the DeviceStore current: an event long-poll for real-time changes, plus a
 * periodic full refresh that reconciles anything missed. Both recover on their own
 * with jittered backoff. The original plugin gave up permanently after one failure.
 */
export class SyncEngine {
  private ctrl = new AbortController();
  private running = false;
  private refreshTimer?: NodeJS.Timeout;
  private pendingRefresh?: NodeJS.Timeout;
  private refreshInFlight?: Promise<boolean>;
  private refreshFailures = 0;
  private lastWarn = new Map<string, number>();

  constructor(
    private readonly client: XfinityClient,
    private readonly store: DeviceStore,
    private readonly log: Log,
    private readonly opts: SyncOptions = DEFAULT_SYNC,
  ) {}

  /** Resolves after the first successful refresh (or stays pending until one succeeds). */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.ctrl = new AbortController();
    while (this.running && !(await this.refresh())) {
      const wait = this.client.authBroken ? this.opts.authRetryMs : backoffMs(this.refreshFailures - 1);
      this.log.debug(`Initial device load failed, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, this.ctrl.signal);
    }
    if (!this.running) {
      return;
    }
    this.scheduleNextRefresh();
    if (this.opts.useEvents) {
      this.eventLoop().catch(err => this.log.error(`Xfinity event stream stopped: ${err instanceof Error ? err.message : err}`));
    }
  }

  stop(): void {
    this.running = false;
    this.ctrl.abort();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.pendingRefresh);
  }

  /** True when state is recent enough to report to HomeKit. */
  isFresh(now = Date.now()): boolean {
    const staleAfter = Math.max(3 * this.opts.refreshIntervalMs, 15 * 60_000);
    return this.store.lastUpdate > 0 && now - this.store.lastUpdate < staleAfter;
  }

  /** Full device-list refresh; concurrent callers share one request. */
  refresh(): Promise<boolean> {
    this.refreshInFlight ??= (async () => {
      try {
        const devices = await this.client.getDevices();
        if (!devices.length && this.store.all().length) {
          throw new Error('Xfinity returned an empty device list; keeping the last known state');
        }
        this.store.applySnapshot(devices);
        if (this.refreshFailures > 0) {
          this.log.info('Reconnected to Xfinity.');
        }
        this.refreshFailures = 0;
        return true;
      } catch (err) {
        this.refreshFailures++;
        this.report('refresh', err);
        return false;
      } finally {
        this.refreshInFlight = undefined;
      }
    })();
    return this.refreshInFlight;
  }

  /** Coalesce bursts of "something changed" into one refresh shortly after. */
  requestRefresh(delayMs = 1_500): void {
    if (this.pendingRefresh || !this.running) {
      return;
    }
    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = undefined;
      this.refresh().catch(() => undefined); // refresh() logs its own failures
    }, delayMs);
  }

  private scheduleNextRefresh(): void {
    clearTimeout(this.refreshTimer);
    if (!this.running) {
      return;
    }
    const failing = this.refreshFailures > 0;
    const wait = failing
      ? (this.client.authBroken ? this.opts.authRetryMs : Math.min(backoffMs(this.refreshFailures - 1), this.opts.refreshIntervalMs))
      : this.opts.refreshIntervalMs;
    this.refreshTimer = setTimeout(async () => {
      await this.refresh();
      this.scheduleNextRefresh();
    }, wait);
  }

  private async eventLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let events: DeltaEvent[];
      const started = Date.now();
      try {
        events = await this.client.waitForDelta(this.ctrl.signal, this.opts.deltaTimeoutMs);
        failures = 0;
        if (!events.length && Date.now() - started < 1_000) {
          await sleep(2_000, this.ctrl.signal); // server answered instantly: don't spin
        }
      } catch (err) {
        if (!this.running) {
          return;
        }
        if (isTimeout(err)) {
          continue; // long-poll expired with no activity: normal
        }
        failures++;
        this.report('events', err);
        const wait = this.client.authBroken ? this.opts.authRetryMs : backoffMs(failures - 1);
        await sleep(wait, this.ctrl.signal);
        this.requestRefresh(0); // catch up on whatever happened while the stream was down
        continue;
      }
      let unknown = 0;
      for (const ev of events) {
        if (!this.store.applyEvent(ev)) {
          unknown++;
          this.log.debug(`Unhandled event ${ev.mediaType} for ${ev.deviceId ?? 'panel'}; will refresh`);
        }
      }
      if (unknown) {
        this.requestRefresh();
      }
    }
  }

  /** Log errors without flooding: same category at most once per 10 minutes at warn level. */
  private report(category: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthRejectedError) {
      const last = this.lastWarn.get('auth') ?? 0;
      if (Date.now() - last > 60 * 60_000) {
        this.lastWarn.set('auth', Date.now());
        this.log.error(`${msg} Paste a new refresh token into the plugin config and restart Homebridge.`);
      }
      return;
    }
    const last = this.lastWarn.get(category) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      this.lastWarn.set(category, Date.now());
      this.log.warn(`Xfinity ${category} error (will keep retrying): ${msg}`);
    } else {
      this.log.debug(`Xfinity ${category} error: ${msg}`);
    }
  }
}
