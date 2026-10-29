/* A small stand-in for Comcast's xhome API, close to the shapes the real one returns. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }

export class FakeXfinity {
  server = http.createServer((q, r) => void this.handle(q, r));
  base = '';
  requests: Recorded[] = [];
  validRefresh = new Set<string>(['rt-0']);
  private n = 0;
  accessTokens = new Set<string>();
  sessions = new Set<string>();
  pin = '1234';
  /** fail the next N device-list calls with 500 */
  failDevices = 0;
  /** reject the next authenticated call with 401 (expired token) */
  expireNext = false;
  /** events waiting for the next delta poll */
  queue: unknown[] = [];
  private waiters: Array<() => void> = [];
  armDelayMs = 150;
  /** false = account like the user's: Comcast has no iControl link, icontrol routes 403 */
  icontrol = true;
  /** devices listed in GET /client (the profile) */
  profileDevices: Record<string, unknown>[] = [];
  /** CVR events per camera MAC, served at /camera/<mac>/events */
  camEvents: Record<string, Array<Record<string, unknown>>> = {};
  /** reject the next N thumbnail fetches with 403 (expired signed URL) */
  expireThumb = 0;
  /** signed-URL token currently accepted by the media hosts */
  mediaToken = 'm1';
  /** like the real playback-cvr host: 401 unless the app's bearer token is sent too */
  cvrNeedsBearer = false;
  /** live thumbnails answer 200 with JSON instead of an image (one plausible real failure) */
  liveThumbBroken = false;
  stillJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9]);
  jpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  panel = {
    id: 'panel-1', hardwareId: 'HW-PANEL', deviceType: 'panel', model: 'TCA300', manufacturer: 'iControl',
    serialNumber: 'P1', firmwareVersion: '10.1.2', status: 'online', name: '', trouble: [] as { name: string }[],
    _links: {
      'self': { href: 'https://xhomeapi-lb-prod.apps.cloud.comcast.net/client/icontrol/devices/panel-1' },
      'panel/arm': { href: '/icontrol/rest/panel/arm', method: 'POST' },
      'panel/disarm': { href: '/icontrol/rest/panel/disarm', method: 'POST' },
    },
    properties: { status: 'ready', armType: '' },
  };

  devices: Record<string, unknown>[] = [
    this.panel,
    {
      id: 'door-1', hardwareId: 'HW-DOOR', deviceType: 'sensor', name: ' Front Door', model: 'XHS2', manufacturer: 'Visonic',
      serialNumber: 'D1', status: 'online', trouble: [],
      _links: { self: { href: 'https://xhomeapi-lb-prod.apps.cloud.comcast.net/client/icontrol/devices/door-1' },
        isBypassed: { href: '/icontrol/rest/door-1/bypass', method: 'POST' } },
      properties: { sensorType: 'dryContact', type: 'door', isFaulted: false, isBypassed: false, temperature: 2150, label: 'Front Door' },
    },
    {
      id: 'motion-1', hardwareId: 'HW-MOTION', deviceType: 'sensor', name: 'Hallway Motion', model: 'XHS3', status: 'online', trouble: [],
      _links: { self: { href: '/client/icontrol/devices/motion-1' } },
      properties: { sensorType: 'motion', isFaulted: false, isBypassed: false, temperature: 2000 },
    },
    {
      id: 'smoke-1', hardwareId: 'HW-SMOKE', deviceType: 'sensor', name: 'Kitchen Smoke', status: 'online', trouble: [],
      _links: {}, properties: { sensorType: 'smoke', isFaulted: false },
    },
    {
      id: 'light-1', hardwareId: 'HW-LIGHT', deviceType: 'lightDimmer', name: 'Porch Light', status: 'online', trouble: [],
      _links: { isOn: { href: '/icontrol/rest/light-1/isOn' }, level: { href: '/icontrol/rest/light-1/level' } },
      properties: { isOn: false, level: 40, dimAllowed: true },
    },
    { id: 'kp-1', hardwareId: 'HW-KP', deviceType: 'peripheral', name: 'Keypad', properties: { type: 'keypad' } },
    { id: 'cam-1', hardwareId: 'HW-CAM', deviceType: 'camera', name: 'Driveway', properties: { videoCodec: 'H264', videoFormat: 'FLV' } },
  ];

  async start(): Promise<string> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  stop(): Promise<void> {
    this.waiters.splice(0).forEach(w => w());
    this.server.closeAllConnections();
    return new Promise(r => this.server.close(() => r()));
  }

  push(event: unknown): void {
    this.queue.push(event);
    this.waiters.splice(0).forEach(w => w());
  }

  private send(r: http.ServerResponse, status: number, body: unknown) {
    r.writeHead(status, { 'Content-Type': 'application/json' });
    r.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async handle(q: http.IncomingMessage, r: http.ServerResponse) {
    let body = '';
    for await (const c of q) {
      body += c;
    }
    const url = new URL(q.url!, this.base);
    this.requests.push({ method: q.method!, path: url.pathname, headers: q.headers, body });

    if (url.pathname === '/oauth/token') {
      const f = new URLSearchParams(body);
      const rt = f.get('refresh_token')!;
      if (f.get('grant_type') !== 'refresh_token' || !this.validRefresh.has(rt)) {
        return this.send(r, 400, { error: 'invalid_grant', error_description: `bad token ${rt}` });
      }
      this.validRefresh.delete(rt); // strict rotation
      const next = `rt-${++this.n}`;
      this.validRefresh.add(next);
      const at = `at-${this.n}`;
      this.accessTokens.add(at);
      return this.send(r, 200, { access_token: at, token_type: 'Bearer', refresh_token: next, expires_in: 3600 });
    }

    // media hosts (*.sys.comcast.net in real life): authorised by the signed token in the URL only
    const cvr = url.pathname.match(/^\/camera\/([0-9A-F]{12})\/events$/);
    if (cvr) {
      if (url.searchParams.get('token') !== this.mediaToken || !url.searchParams.get('start')) {
        return this.send(r, 403, 'bad token');
      }
      if (this.cvrNeedsBearer && !this.accessTokens.has(String(q.headers.authorization ?? '').replace('Bearer ', ''))) {
        return this.send(r, 401, 'unauthorized');
      }
      const start = Date.parse(url.searchParams.get('start')!);
      return this.send(r, 200, { events: (this.camEvents[cvr[1]] ?? [])
        .filter(e => Date.parse(String(e.startTime)) >= start)
        .map((e, i) => ({ ...e, links: [{ type: 'thumbnail', templated: true,
          href: `https://playback-cvr.sys.comcast.net/camera/photoext/${cvr[1]}-${i}.jpeg/v2?context=x&token=${this.mediaToken}` }] })) });
    }
    if (url.pathname.startsWith('/camera/photoext/')) {
      if (url.searchParams.get('token') !== this.mediaToken ||
        (this.cvrNeedsBearer && !this.accessTokens.has(String(q.headers.authorization ?? '').replace('Bearer ', '')))) {
        return this.send(r, 401, 'unauthorized');
      }
      r.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return r.end(this.stillJpeg);
    }
    if (/^\/user\/[0-9A-F]{12}\/thumbnail$/.test(url.pathname)) {
      if (this.liveThumbBroken) {
        return this.send(r, 200, { error: 'camera offline' });
      }
      if (this.expireThumb > 0 || url.searchParams.get('token') !== this.mediaToken) {
        this.expireThumb = Math.max(0, this.expireThumb - 1);
        return this.send(r, 403, 'expired');
      }
      r.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return r.end(this.jpeg);
    }

    const auth = String(q.headers.authorization ?? '').replace('Bearer ', '');
    if (!this.accessTokens.has(auth)) {
      return this.send(r, 401, 'unauthorized');
    }
    if (url.pathname === '/client') {
      const s = `sess-${auth}`;
      this.sessions.add(s);
      return this.send(r, 200, {
        sessionInfo: { sessionHeaderValue: s, hasIcontrolAccount: this.icontrol, accountTier: this.icontrol ? 'XH' : 'INTERNET' },
        devices: this.profileDevices.map(d => this.signLinks(d)),
      });
    }
    if (!this.sessions.has(String(q.headers['xh-auth']))) {
      return this.send(r, 401, 'no session');
    }
    if (url.pathname === '/client/nextgenThumbnails') {
      return this.send(r, 200, this.profileDevices.filter(d => d.deviceType === 'camera').map(d => ({
        cameraMac: String(d.macAddress), url: `https://livecache-read-cvr.sys.comcast.net/user/${d.macAddress}/thumbnail?token=${this.mediaToken}`,
      })));
    }
    if (!this.icontrol && url.pathname.startsWith('/client/icontrol')) {
      return this.send(r, 403, { message: 'Forbidden' });
    }
    if (this.expireNext) {
      this.expireNext = false;
      this.accessTokens.clear();
      this.sessions.clear();
      return this.send(r, 401, 'expired');
    }

    if (url.pathname === '/client/icontrol/devices' && q.method === 'GET') {
      if (this.failDevices > 0) {
        this.failDevices--;
        return this.send(r, 500, 'boom');
      }
      return this.send(r, 200, { devices: this.devices });
    }
    if (url.pathname === '/client/icontrol/delta') {
      if (!this.queue.length) {
        await new Promise<void>(res => {
          this.waiters.push(res);
          setTimeout(res, 400);
        });
      }
      return this.send(r, 200, this.queue.splice(0));
    }
    if (url.pathname === '/client/icontrol/panel/arm') {
      const f = new URLSearchParams(body);
      if (f.get('code') !== this.pin) {
        return this.send(r, 403, { message: 'Invalid code' });
      }
      if (this.panel.properties.status === 'notReady') {
        return this.send(r, 409, { message: 'NOT_READY' });
      }
      const armType = f.get('armType')!;
      this.setPanel('arming', armType);
      setTimeout(() => this.setPanel('armed', armType), this.armDelayMs);
      return this.send(r, 200, { commandId: 'c1' });
    }
    if (url.pathname === '/client/icontrol/panel/disarm') {
      const f = new URLSearchParams(body);
      if (f.get('code') !== this.pin) {
        return this.send(r, 403, { message: 'Invalid code' });
      }
      this.setPanel('ready', '');
      return this.send(r, 200, { commandId: 'c2' });
    }
    if (url.pathname === '/client/icontrol/update/device') {
      const f = new URLSearchParams(body);
      const light = this.devices.find(d => d.id === 'light-1') as { properties: Record<string, unknown> };
      if (f.get('path')?.endsWith('/isOn')) {
        light.properties.isOn = f.get('value') === 'true';
      } else if (f.get('path')?.endsWith('/level')) {
        light.properties.level = Number(f.get('value'));
      }
      this.push({ deviceId: 'light-1', mediaType: 'event/lighting',
        metadata: { isOn: String(light.properties.isOn), level: String(light.properties.level) } });
      return this.send(r, 200, { ok: true });
    }
    return this.send(r, 404, `404 Not Found: Requested route ('${q.headers.host}') does not exist.`);
  }

  private signLinks(d: Record<string, unknown>): Record<string, unknown> {
    if (d.deviceType !== 'camera') {
      return d;
    }
    return { ...d, _links: { cvrEvents: { templated: true,
      href: `https://playback-cvr.sys.comcast.net/camera/${d.macAddress}/events?start={start}{&end}&token=${this.mediaToken}` } } };
  }

  setPanel(status: string, armType: string): void {
    this.panel.properties.status = status;
    this.panel.properties.armType = armType;
    this.push({ deviceId: null, mediaType: 'event/securityStateChange', metadata: { status, armType: armType || null } });
  }
}
