import assert from 'node:assert/strict';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { TokenStore } from '../src/api/TokenStore';
import { AuthRejectedError, XfinityClient, XfinityHttpError } from '../src/api/XfinityClient';
import { SlideshowSession } from '../src/cameras/SlideshowStream';
import { camerasFromProfile, expandTemplate, newestThumbnail, parseEventTimes } from '../src/cameras/CameraPoller';
import { DeviceStore } from '../src/model/DeviceStore';
import { classify, normalize, safeName } from '../src/model/normalize';
import { SyncEngine } from '../src/sync/SyncEngine';
import { redact, redactString } from '../src/util/redact';
import { FakeXfinity } from './fakeXfinity';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xfh-')), 'token.json');

const endpoints = (base: string) => ({ oauthUrl: `${base}/oauth/token`, apiBase: base, clientAuth: 'Basic dGVzdA==' });

describe('TokenStore', () => {
  it('persists rotated tokens with mode 600 and prefers them over the stale config token', async () => {
    const file = await tmpFile();
    const a = new TokenStore(file);
    assert.equal(await a.load('rt-config'), 'rt-config');
    await a.save('rt-rotated');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const b = new TokenStore(file);
    assert.equal(await b.load('rt-config'), 'rt-rotated', 'restart must use the rotated token');
  });

  it('moves a token from a pre-release folder once, then keeps rotating in the new folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfh-mig-'));
    const oldFile = path.join(dir, 'xfinityhome-local', 'token.json');
    const newFile = path.join(dir, 'xfinity-cameras', 'token.json');
    await new TokenStore(oldFile).save('rt-old-chain');
    const store = new TokenStore(newFile, () => {}, [oldFile]);
    assert.equal(await store.load(undefined), 'rt-old-chain');
    assert.equal(JSON.parse(await fs.readFile(newFile, 'utf8')).refreshToken, 'rt-old-chain');
    assert.equal(statSync(newFile).mode & 0o777, 0o600);
    await store.save('rt-next');
    assert.equal(await new TokenStore(newFile, () => {}, [oldFile]).load(undefined), 'rt-next', 'new folder wins after migration');
  });

  it('starts a new chain when the user pastes a different config token', async () => {
    const file = await tmpFile();
    const a = new TokenStore(file);
    await a.load('rt-old');
    await a.save('rt-old-rotated');
    const b = new TokenStore(file);
    assert.equal(await b.load('rt-new-capture'), 'rt-new-capture');
  });
});

describe('XfinityClient against fake server', () => {
  const fake = new FakeXfinity();
  before(() => fake.start());
  after(() => fake.stop());

  it('refreshes, saves the rotated token, and never follows absolute hrefs to other hosts', async () => {
    const tokens = new TokenStore(await tmpFile());
    await tokens.load('rt-0');
    const client = new XfinityClient(tokens, endpoints(fake.base));
    const devices = await client.getDevices();
    assert.equal(devices.length, 7);
    assert.equal(tokens.token, 'rt-1', 'rotated token stored');
    assert.equal(client.url('https://xhomeapi-lb-prod.apps.cloud.comcast.net/client/x?y=1'), `${fake.base}/client/x?y=1`);
  });

  it('retries once after a 401 with a fresh session', async () => {
    const tokens = new TokenStore(await tmpFile());
    fake.validRefresh.add('rt-retry');
    await tokens.load('rt-retry');
    const client = new XfinityClient(tokens, endpoints(fake.base));
    await client.getDevices();
    fake.expireNext = true;
    const devices = await client.getDevices();
    assert.equal(devices.length, 7);
  });

  it('reports a rejected refresh token clearly and without leaking it', async () => {
    const tokens = new TokenStore(await tmpFile());
    await tokens.load('rt-bogus-SECRETVALUE');
    const client = new XfinityClient(tokens, endpoints(fake.base));
    await assert.rejects(client.getDevices(), (err: Error) => {
      assert.ok(err instanceof AuthRejectedError);
      assert.ok(!err.message.includes('SECRETVALUE'), err.message);
      return true;
    });
    assert.equal(client.authBroken, true);
  });

  it('wraps HTTP errors with redacted bodies', () => {
    const e = new XfinityHttpError(500, 'POST', '/x', 'refresh_token=abc123456&code=9999 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij');
    assert.ok(!/abc123456|9999|eyJhbGci/.test(e.message), e.message);
  });
});

describe('normalize + DeviceStore', () => {
  it('classifies device types like the original plugin', () => {
    assert.equal(classify({ id: '1', deviceType: 'sensor', properties: { sensorType: 'dryContact' } }), 'contact');
    assert.equal(classify({ id: '1', deviceType: 'sensor', properties: { type: 'window' } }), 'contact');
    assert.equal(classify({ id: '1', deviceType: 'sensor', properties: { type: 'motion' } }), 'motion');
    assert.equal(classify({ id: '1', deviceType: 'sensor', properties: { sensorType: 'water' } }), 'leak');
    assert.equal(classify({ id: '1', deviceType: 'lightSwitch' }), 'light');
    assert.equal(classify({ id: '1', deviceType: 'peripheral' }), 'ignored');
    assert.equal(classify({ id: '1', deviceType: 'sensor', model: 'TCHU1AL0' }), 'ignored');
  });

  it('converts temperature and names', () => {
    const s = normalize({ id: 'd', deviceType: 'sensor', name: ' Front Door ', properties: { sensorType: 'dryContact', temperature: 2150 } });
    assert.equal(s.temperatureC, 21.5);
    assert.equal(safeName(' Master Bedroom'), 'Master Bedroom');
    assert.equal(safeName('🔥Kitchen!!'), 'Kitchen');
  });

  it('applies delta events and clears troubles on *Res events', () => {
    const fake = new FakeXfinity();
    const store = new DeviceStore();
    store.applySnapshot(fake.devices as never);
    assert.equal(store.applyEvent({ deviceId: 'door-1', mediaType: 'event/zone', name: 'isFaulted', value: 'true' }), true);
    assert.equal(store.get('door-1')!.faulted, true);
    store.applyEvent({ deviceId: 'door-1', mediaType: 'event/zone', name: 'trouble', value: 'senTamp' });
    assert.deepEqual(store.get('door-1')!.troubles, ['senTamp']);
    store.applyEvent({ deviceId: 'door-1', mediaType: 'event/zone', name: 'trouble', value: 'senTampRes' });
    assert.deepEqual(store.get('door-1')!.troubles, []);
    store.applyEvent({ deviceId: null, mediaType: 'event/securityStateChange', metadata: { status: 'armed', armType: 'away' } });
    assert.equal(store.panel()!.armType, 'away');
    assert.equal(store.applyEvent({ deviceId: 'door-1', mediaType: 'event/somethingNew' }), false);
  });
});

describe('SyncEngine', () => {
  it('recovers from server errors and streams events into the store', async () => {
    const fake = new FakeXfinity();
    await fake.start();
    fake.failDevices = 2;
    try {
      const tokens = new TokenStore(await tmpFile());
      fake.validRefresh.add('rt-sync');
      await tokens.load('rt-sync');
      const client = new XfinityClient(tokens, endpoints(fake.base));
      const store = new DeviceStore();
      const sync = new SyncEngine(client, store, quiet, {
        refreshIntervalMs: 60_000, deltaTimeoutMs: 2_000, useEvents: true, authRetryMs: 60_000,
      });
      const backoff = await import('../src/util/backoff');
      void backoff; // backoff is real; 2 failures => a few seconds at most
      const t0 = Date.now();
      await sync.start();
      assert.ok(Date.now() - t0 < 15_000);
      assert.ok(sync.isFresh());

      const changed = new Promise<void>(res => store.on('change', s => s.id === 'motion-1' && s.faulted && res()));
      fake.push({ deviceId: 'motion-1', mediaType: 'event/zone', name: 'isFaulted', value: 'true' });
      await changed;
      sync.stop();
    } finally {
      await fake.stop();
    }
  });
});

describe('redact', () => {
  it('masks secret fields deeply but keeps diagnostics', () => {
    const r = redact({ refresh_token: 'abc', nested: { Authorization: 'Bearer x', statusCode: 404, pin: '1234' } });
    assert.equal(r.refresh_token, '[redacted:3]');
    assert.equal((r.nested as { statusCode: number }).statusCode, 404);
    assert.equal((r.nested as { pin: string }).pin, '[redacted:4]');
    assert.equal(redactString('grant_type=refresh_token&refresh_token=zzz'), 'grant_type=refresh_token&refresh_token=[redacted]');
  });
});

describe('camera helpers', () => {
  it('expands the CVR events template like the Xfinity app formats dates', () => {
    const t = 'https://playback-cvr-aws-eu1.sys.comcast.net/camera/00AABBCC0001/events?start={start}{&end}&token=abc';
    assert.equal(expandTemplate(t, new Date('2026-10-28T14:27:04.123Z'), new Date('2026-10-28T15:00:00Z')),
      'https://playback-cvr-aws-eu1.sys.comcast.net/camera/00AABBCC0001/events?start=2026-10-28T14%3A27%3A04Z&end=2026-10-28T15%3A00%3A00Z&token=abc');
    assert.ok(!expandTemplate(t, new Date()).includes('{'));
    assert.equal(expandTemplate(t, new Date(1761661624000), undefined, 'ms'),
      'https://playback-cvr-aws-eu1.sys.comcast.net/camera/00AABBCC0001/events?start=1761661624000&token=abc');
  });

  it('parses event times from the shapes Comcast uses', () => {
    // the events/v2 shape seen in the capture
    assert.deepEqual(parseEventTimes({ events: [{ startTime: '2026-10-28T14:27:04Z', links: [] }, { startTime: '2026-10-28T03:33:24Z' }] }),
      [Date.parse('2026-10-28T14:27:04Z'), Date.parse('2026-10-28T03:33:24Z')]);
    assert.deepEqual(parseEventTimes([{ start: 1761661624 }, { timestamp: '1761661624000' }, { time: 'nope' }, null]),
      [1761661624000, 1761661624000]);
    assert.deepEqual(parseEventTimes('garbage'), []);
    assert.deepEqual(parseEventTimes({ events: 'x' }), []);
    assert.equal(newestThumbnail({ events: [
      { startTime: '2026-10-28T03:33:24Z', links: [{ type: 'thumbnail', href: 'https://p.sys.comcast.net/old.jpeg?token=a' }] },
      { startTime: '2026-10-28T14:27:04Z', links: [{ type: 'thumbnail', templated: true, href: 'https://p.sys.comcast.net/new.jpeg/v2?context=c{&w}&token=a' }] },
    ] }), 'https://p.sys.comcast.net/new.jpeg/v2?context=c&token=a');
    assert.equal(newestThumbnail([{ start: 1, _links: { thumbnail: { href: 'https://h.comcast.net/t.jpg' } } }]), 'https://h.comcast.net/t.jpg');
    assert.equal(newestThumbnail({ events: [{ startTime: 'x' }] }), undefined);
  });

  it('builds camera info from the /client profile', () => {
    const [c] = camerasFromProfile([
      { id: 'xbo:1', hardwareId: 'xbo:1', deviceType: 'camera', name: 'Driveway ', model: 'xCam2', serialNumber: 'C1',
        firmwareVersion: 'SCHC2AEW', properties: { label: 'Driveway ' },
        _links: { cvrEvents: { href: 'https://playback-cvr-aws-eu1.sys.comcast.net/camera/00aabbcc0001/events?start={start}' } } },
      { id: 'door', deviceType: 'sensor' },
    ]);
    assert.equal(c.name, 'Driveway');
    assert.equal(c.mac, '00AABBCC0001');
    assert.equal(camerasFromProfile([{ id: 'x', deviceType: 'camera', macAddress: '00:aa:bb:cc:00:02' }])[0].mac, '00AABBCC0002');
  });

  it('refuses to send signed fetches anywhere but Comcast over HTTPS', async () => {
    const client = new XfinityClient(new TokenStore(path.join(os.tmpdir(), 'xfh-unused.json'), () => {}));
    await assert.rejects(client.fetchSigned('https://evil.example.com/x.comcast.net', 'json'), /non-Comcast/);
    await assert.rejects(client.fetchSigned('http://playback.sys.comcast.net/x', 'json'), /non-Comcast/);
  });
});

describe('live view robustness', () => {
  it('a missing ffmpeg ends the session with a reason instead of crashing Homebridge', async () => {
    let ended = '';
    const s = new SlideshowSession(false, async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), r => (ended = r), {
      ffmpegPath: '/nonexistent/ffmpeg', refreshMs: 1000, idleTimeoutMs: 5000, maxSessionMs: 10000,
    });
    await s.bind();
    await s.start({ address: '127.0.0.1', ipv6: false, port: 9, srtpKey: Buffer.alloc(16), srtpSalt: Buffer.alloc(14),
      ssrc: 1, payloadType: 99, width: 640, height: 360, fps: 15, maxBitrateKbps: 300, mtu: 1378 });
    for (let i = 0; i < 40 && !ended; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.match(ended, /could not run ffmpeg/);
  });
});
