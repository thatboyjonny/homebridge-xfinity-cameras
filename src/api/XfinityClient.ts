import { redactString } from '../util/redact';
import { TokenStore } from './TokenStore';
import type { ClientProfile, RawDevice, DeltaEvent } from './types';

export interface Endpoints {
  /** OAuth token endpoint used to exchange the refresh token. */
  oauthUrl: string;
  /** Base URL of the Xfinity Home ("xhome") client API. */
  apiBase: string;
  /** Basic client credential the Xfinity Home iOS app uses (public, baked into the app). */
  clientAuth: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  oauthUrl: 'https://oauth.xfinity.com/oauth/token',
  apiBase: 'https://xhomeapi-lb-prod.codebig2.net',
  clientAuth: 'Basic WGZpbml0eS1Ib21lLWlPUy1BcHA6NzdiMzY2ZjlhMTM1YzdhYjM5MTA0NDIzNGEyNmIxZDZiMWUwOGY2Ng==',
};

const CLIENT_FEATURES = 'auth4all,carousel,carousel-devicedeeplink,no-cookie,deeplinkV1';

export class XfinityHttpError extends Error {
  constructor(readonly status: number, readonly method: string, readonly path: string, body: string) {
    super(`${method} ${path} -> HTTP ${status}${body ? `: ${redactString(body).slice(0, 300)}` : ''}`);
    this.name = 'XfinityHttpError';
  }
}

/** The refresh token was rejected. Only a new token (fresh capture) fixes this. */
export class AuthRejectedError extends Error {
  constructor(status: number, body: string, token?: string) {
    const scrubbed = token ? body.split(token).join('[redacted]') : body;
    super(`Xfinity rejected the refresh token (HTTP ${status}). Capture a new token. ${redactString(scrubbed).slice(0, 200)}`);
    this.name = 'AuthRejectedError';
  }
}

export interface RequestOptions {
  form?: Record<string, string | number | boolean>;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** internal: set on the automatic retry after a 401 */
  retried?: boolean;
}

type Fetch = typeof fetch;

/**
 * Talks to Comcast. Owns access-token refresh, the Xh-Auth session header, the 401 retry,
 * and path handling. It never follows server-supplied absolute URLs to other hosts: any
 * absolute href is re-based onto `apiBase`, which is what broke sensor polling in Sept 2026.
 */
export type SignedAuth = 'none' | 'bearer' | 'bearer+session';
const SIGNED_AUTH: SignedAuth[] = ['none', 'bearer', 'bearer+session'];

export class XfinityClient {
  private accessToken?: string;
  private accessExpiresAt = 0;
  private xhAuth?: string;
  private tokenFlight?: Promise<string>;
  private sessionFlight?: Promise<string>;
  /** set when the refresh token is rejected; cleared when a new token is stored */
  authBroken = false;

  constructor(
    private readonly tokens: TokenStore,
    readonly endpoints: Endpoints = DEFAULT_ENDPOINTS,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- auth ----------

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.now() < this.accessExpiresAt - 60_000) {
      return this.accessToken;
    }
    this.tokenFlight ??= this.refreshAccessToken().finally(() => (this.tokenFlight = undefined));
    return this.tokenFlight;
  }

  private async refreshAccessToken(): Promise<string> {
    const refresh = this.tokens.token;
    if (!refresh) {
      this.authBroken = true;
      throw new AuthRejectedError(0, 'No refresh token configured.');
    }
    const body = new URLSearchParams({
      redirect_uri: 'xfinityhome://auth', refresh_token: refresh, grant_type: 'refresh_token',
    });
    const res = await this.fetchImpl(this.endpoints.oauthUrl, {
      method: 'POST',
      headers: { 'Authorization': this.endpoints.clientAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      this.authBroken = true;
      throw new AuthRejectedError(res.status, text, refresh);
    }
    if (!res.ok) {
      throw new XfinityHttpError(res.status, 'POST', new URL(this.endpoints.oauthUrl).pathname, text.split(refresh).join('[redacted]'));
    }
    const data = JSON.parse(text) as { access_token: string; token_type?: string; refresh_token?: string; expires_in?: number };
    if (data.refresh_token && data.refresh_token !== refresh) {
      await this.tokens.save(data.refresh_token);
    }
    this.authBroken = false;
    this.accessToken = `${data.token_type ?? 'Bearer'} ${data.access_token}`;
    this.accessExpiresAt = this.now() + (data.expires_in ?? 600) * 1000;
    this.xhAuth = undefined; // session header is tied to the access token
    return this.accessToken;
  }

  private async getSession(): Promise<string> {
    if (this.xhAuth) {
      return this.xhAuth;
    }
    this.sessionFlight ??= (async () => {
      const token = await this.getAccessToken();
      const res = await this.fetchImpl(this.url('/client'), {
        headers: { 'Authorization': token, 'X-Client-Features': CLIENT_FEATURES },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 401) {
          this.accessToken = undefined;
        }
        throw new XfinityHttpError(res.status, 'GET', '/client', text);
      }
      const value = (JSON.parse(text) as { sessionInfo?: { sessionHeaderValue?: string } }).sessionInfo?.sessionHeaderValue;
      if (!value) {
        throw new Error('Xfinity profile response had no sessionInfo.sessionHeaderValue');
      }
      this.xhAuth = value;
      return value;
    })().finally(() => (this.sessionFlight = undefined));
    return this.sessionFlight;
  }

  /** Drop cached credentials (not the refresh token). */
  resetSession(): void {
    this.accessToken = undefined;
    this.accessExpiresAt = 0;
    this.xhAuth = undefined;
  }

  // ---------- transport ----------

  /** Re-base any absolute or relative href onto apiBase. */
  url(pathOrHref: string): string {
    const base = this.endpoints.apiBase.replace(/\/+$/, '');
    let p = pathOrHref;
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      p = u.pathname + u.search;
    }
    return base + (p.startsWith('/') ? p : '/' + p);
  }

  async request<T = unknown>(method: 'GET' | 'POST', pathOrHref: string, opts: RequestOptions = {}): Promise<T> {
    const [token, session] = [await this.getAccessToken(), await this.getSession()];
    const headers: Record<string, string> = {
      'Authorization': token, 'Xh-Auth': session, 'X-Client-Features': CLIENT_FEATURES,
    };
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(opts.form).map(([k, v]): [string, string] => [k, String(v)])).toString();
    } else if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const target = this.url(pathOrHref);
    const res = await this.fetchImpl(target, { method, headers, body, signal });
    const text = await res.text();
    const shownPath = new URL(target).pathname;

    if (res.status === 401 && !opts.retried) {
      this.resetSession();
      return this.request<T>(method, pathOrHref, { ...opts, retried: true });
    }
    if (!res.ok) {
      throw new XfinityHttpError(res.status, method, shownPath, text);
    }
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  // ---------- API surface ----------

  /** Account profile: device list (incl. cameras) and whether a security (iControl) account is linked. */
  getProfile(): Promise<ClientProfile> {
    return this.request<ClientProfile>('GET', '/client', { timeoutMs: 15_000 });
  }

  /** Current snapshot URLs (token in query) keyed by camera MAC. */
  async getThumbnails(): Promise<Array<{ url: string; cameraMac: string }>> {
    const data = await this.request<Array<{ url: string; cameraMac: string }>>('GET', '/client/nextgenThumbnails');
    return Array.isArray(data) ? data : [];
  }

  /** Which auth each Comcast media host accepted, learned on first success. */
  readonly signedAuth = new Map<string, SignedAuth>();

  /**
   * Fetch a signed Comcast media/CVR URL (token in the query string). Only HTTPS Comcast
   * hosts are allowed. Some hosts also want the app's credentials: on 401/403 this tries
   * the bearer token, then bearer + session header, and remembers what worked per host.
   */
  async fetchSigned(url: string, as: 'json' | 'buffer', timeoutMs = 10_000): Promise<unknown> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)comcast\.(net|com)$/i.test(u.hostname)) {
      throw new Error(`refusing to fetch non-Comcast URL host ${u.hostname}`);
    }
    const known = this.signedAuth.get(u.hostname);
    const order: SignedAuth[] = known ? [known, ...SIGNED_AUTH.filter(m => m !== known)] : [...SIGNED_AUTH];
    const tried: string[] = [];
    for (const mode of order) {
      const headers: Record<string, string> = {};
      if (mode !== 'none') {
        headers.Authorization = await this.getAccessToken();
      }
      if (mode === 'bearer+session') {
        headers['Xh-Auth'] = await this.getSession();
        headers['X-Client-Features'] = CLIENT_FEATURES;
      }
      const res = await this.fetchImpl(u.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        this.signedAuth.set(u.hostname, mode);
        return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
      }
      await res.arrayBuffer().catch(() => undefined);
      tried.push(`${res.status} with ${mode === 'none' ? 'no auth' : mode}`);
      if (res.status !== 401 && res.status !== 403) {
        break; // not an auth problem: trying other credentials won't help
      }
    }
    throw new XfinityHttpError(Number(tried[tried.length - 1]?.slice(0, 3)) || 0, 'GET',
      `${u.hostname}${u.pathname} (${tried.join(', ')})`, '');
  }

  async getDevices(): Promise<RawDevice[]> {
    const data = await this.request<{ devices: RawDevice[] }>('GET', '/client/icontrol/devices', { timeoutMs: 15_000 });
    if (!data || !Array.isArray(data.devices)) {
      throw new Error('Unexpected device list response shape');
    }
    return data.devices;
  }

  /** Long-poll for changes. Resolves with [] when the server times the poll out. */
  async waitForDelta(signal: AbortSignal, timeoutMs: number): Promise<DeltaEvent[]> {
    const data = await this.request<DeltaEvent[] | { events?: DeltaEvent[] }>(
      'GET', '/client/icontrol/delta', { signal, timeoutMs });
    if (Array.isArray(data)) {
      return data;
    }
    return data?.events ?? [];
  }

  arm(armHref: string, pin: string, mode: 'stay' | 'away' | 'night'): Promise<unknown> {
    return this.request('POST', '/client/icontrol/panel/arm', { form: { code: pin, path: armHref, armType: mode } });
  }

  disarm(disarmHref: string, pin: string): Promise<unknown> {
    return this.request('POST', '/client/icontrol/panel/disarm', { form: { path: disarmHref, code: pin } });
  }

  /** Generic property write used for lights (isOn/level) and sensor bypass. */
  updateDevice(href: string, value: string | number | boolean): Promise<unknown> {
    return this.request('POST', '/client/icontrol/update/device', { form: { path: href, value } });
  }
}
