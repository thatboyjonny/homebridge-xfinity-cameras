/* End-to-end: real HAP-NodeJS services/characteristics + real Homebridge PlatformAccessory, fake Comcast. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { after, before, describe, it } from 'node:test';

import { XfinityPlatform } from '../src/platform';
import { FakeXfinity } from './fakeXfinity';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hap = require('@homebridge/hap-nodejs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PlatformAccessory } = require(path.join(path.dirname(require.resolve('homebridge')), 'platformAccessory.js'));

const waitFor = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise(r => setTimeout(r, 25));
  }
};

class FakeApi extends EventEmitter {
  hap = hap;
  platformAccessory = PlatformAccessory;
  registered: InstanceType<typeof PlatformAccessory>[] = [];
  external: InstanceType<typeof PlatformAccessory>[] = [];
  unregistered: unknown[] = [];
  constructor(private dir: string) {
    super();
  }
  user = { storagePath: () => this.dir };
  registerPlatformAccessories(_p: string, _n: string, accs: never[]) {
    this.registered.push(...accs);
  }
  unregisterPlatformAccessories(_p: string, _n: string, accs: never[]) {
    this.unregistered.push(...accs);
  }
  updatePlatformAccessories() {}
  publishExternalAccessories(_p: string, accs: never[]) {
    this.external.push(...accs);
  }
}

const logs: string[] = [];
const log = Object.assign((...a: unknown[]) => logs.push(a.join(' ')), {
  info: (...a: unknown[]) => logs.push('INFO ' + a.join(' ')),
  warn: (...a: unknown[]) => logs.push('WARN ' + a.join(' ')),
  error: (...a: unknown[]) => logs.push('ERROR ' + a.join(' ')),
  debug: (...a: unknown[]) => logs.push('DEBUG ' + a.join(' ')),
  success: () => {}, log: () => {}, prefix: 'test',
});

describe('XfinityPlatform with HAP', () => {
  const fake = new FakeXfinity();
  let api: FakeApi;
  let platform: XfinityPlatform;
  const C = hap.Characteristic;
  const S = hap.Service;
  const acc = (name: string) => api.registered.find(a => a.displayName === name)!;
  const char = (name: string, svc: unknown, ch: unknown) => acc(name).getService(svc).getCharacteristic(ch);

  before(async () => {
    await fake.start();
    fake.validRefresh.add('rt-platform');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfh-hb-'));
    api = new FakeApi(dir);
    platform = new XfinityPlatform(log as never, {
      platform: 'XfinityCameras', refreshToken: 'rt-platform', pin: '1234',
      temperatureSensors: true, advanced: { apiBase: fake.base, oauthUrl: `${fake.base}/oauth/token` },
    } as never, api as never);
    api.emit('didFinishLaunching');
    await waitFor(() => api.registered.length >= 5);
  });

  after(async () => {
    api.emit('shutdown');
    await fake.stop();
  });

  it('registers panel, sensors and light; skips keypad and camera', () => {
    const names = api.registered.map(a => a.displayName).sort();
    assert.deepEqual(names, ['Front Door', 'Hallway Motion', 'Kitchen Smoke', 'Porch Light', 'Security System']);
    assert.ok(!logs.some(l => /rt-\d|at-\d/.test(l)), 'no tokens in logs');
  });

  it('never touches the dead host from server-supplied links', () => {
    assert.ok(!fake.requests.some(r => r.path.includes('devices/panel-1')));
  });

  it('answers sensor reads from cache and follows events', async () => {
    const contact = char('Front Door', S.ContactSensor, C.ContactSensorState);
    assert.equal(await contact.handleGetRequest(), 0);
    const before = fake.requests.length;
    fake.push({ deviceId: 'door-1', mediaType: 'event/zone', name: 'isFaulted', value: 'true',
      metadata: { sensorTemperature: '2300' } });
    await waitFor(() => contact.value === 1);
    assert.equal(acc('Front Door').getService(S.TemperatureSensor).getCharacteristic(C.CurrentTemperature).value, 23);
    await contact.handleGetRequest();
    assert.equal(fake.requests.slice(before).filter(r => r.path === '/client/icontrol/devices').length, 0,
      'a HomeKit read must not trigger an API call');
  });

  it('refuses to arm while not ready and reverts the target', async () => {
    fake.panel.properties.status = 'notReady';
    fake.push({ deviceId: null, mediaType: 'event/securityStateChange', metadata: { status: 'notReady', armType: null } });
    const target = char('Security System', S.SecuritySystem, C.SecuritySystemTargetState);
    await waitFor(() => platform.store.panel()!.panelStatus === 'notReady');
    await assert.rejects(target.handleSetRequest(1), (e: number) => e === hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.ok(logs.some(l => l.includes('Not arming') && l.includes('Front Door')));
    assert.ok(!fake.requests.some(r => r.path === '/client/icontrol/panel/arm'), 'no arm command sent');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(target.value, 3, 'target reverted to disarmed');
    fake.setPanel('ready', '');
    await waitFor(() => platform.store.panel()!.panelStatus === 'ready');
  });

  it('arms away: holds target, reports armed only after confirmation', async () => {
    const target = char('Security System', S.SecuritySystem, C.SecuritySystemTargetState);
    const current = char('Security System', S.SecuritySystem, C.SecuritySystemCurrentState);
    fake.armDelayMs = 400;
    await target.handleSetRequest(1);
    const armReq = fake.requests.find(r => r.path === '/client/icontrol/panel/arm')!;
    assert.match(armReq.body, /armType=away/);
    assert.equal(await target.handleGetRequest(), 1);
    await waitFor(() => platform.store.panel()!.panelStatus === 'arming');
    assert.equal(await current.handleGetRequest(), 3, 'still disarmed during exit delay');
    await waitFor(() => current.value === 1);
    assert.ok(logs.some(l => l.includes('Armed Away')));
  });

  it('disarms with the PIN and a wrong PIN surfaces an error', async () => {
    const target = char('Security System', S.SecuritySystem, C.SecuritySystemTargetState);
    const current = char('Security System', S.SecuritySystem, C.SecuritySystemCurrentState);
    await target.handleSetRequest(3);
    await waitFor(() => current.value === 3);

    platform.config.pin = '0000';
    await assert.rejects(target.handleSetRequest(0), (e: number) => e === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    platform.config.pin = '1234';
    await new Promise(r => setTimeout(r, 300));
    assert.equal(target.value, 3);
  });

  it('shows alarm and entry delay as triggered', async () => {
    const current = char('Security System', S.SecuritySystem, C.SecuritySystemCurrentState);
    fake.setPanel('entryDelay', 'away');
    await waitFor(() => current.value === 4);
    fake.setPanel('ready', '');
    await waitFor(() => current.value === 3);
  });

  it('controls the dimmer and reflects confirmation', async () => {
    const on = char('Porch Light', S.Lightbulb, C.On);
    const bri = char('Porch Light', S.Lightbulb, C.Brightness);
    assert.equal(await bri.handleGetRequest(), 40);
    await on.handleSetRequest(true);
    await bri.handleSetRequest(75);
    await waitFor(() => on.value === true && bri.value === 75);
  });

  it('reports No Response when data goes stale', async () => {
    const contact = char('Front Door', S.ContactSensor, C.ContactSensorState);
    platform.store.lastUpdate = Date.now() - 2 * 60 * 60_000;
    await assert.rejects(contact.handleGetRequest(), (e: number) =>
      e === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    platform.store.lastUpdate = Date.now();
  });
});

describe('camera-only account (no iControl link, like this home)', () => {
  const fake = new FakeXfinity();
  let api: FakeApi;
  let platform: XfinityPlatform;
  const C = hap.Characteristic;
  const S = hap.Service;
  const realFetch = globalThis.fetch;
  const media: string[] = [];
  const MAC1 = '00AABBCC0001';
  const MAC2 = '00AABBCC0002';

  before(async () => {
    await fake.start();
    fake.icontrol = false;
    fake.validRefresh.add('rt-cam');
    fake.profileDevices = [
      { id: 'xbo:1', hardwareId: 'xbo:1', deviceType: 'camera', name: 'Driveway ', model: 'xCam2', serialNumber: 'C1',
        firmwareVersion: 'SCHC2AEW', macAddress: MAC1, properties: { label: 'Driveway ' } },
      { id: 'xbo:2', hardwareId: 'xbo:2', deviceType: 'camera', name: 'Back yard', model: 'xCam2', serialNumber: 'C2',
        firmwareVersion: 'SCHC2AEW', macAddress: MAC2, properties: { label: 'Back yard' } },
    ];
    fake.camEvents[MAC1] = [{ startTime: new Date(Date.now() - 60_000).toISOString() }]; // an old clip: must not fire
    // route *.comcast.net media hosts to the fake server; production code only allows https Comcast hosts
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname.endsWith('comcast.net')) {
        media.push(`${u.hostname}${u.pathname}`);
        return realFetch(`${fake.base}${u.pathname}${u.search}`, init);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfh-cam-'));
    api = new FakeApi(dir);
    platform = new XfinityPlatform(log as never, {
      platform: 'XfinityCameras', refreshToken: 'rt-cam',
      advanced: { apiBase: fake.base, oauthUrl: `${fake.base}/oauth/token` },
    } as never, api as never);
    // a bridged camera left over from 0.2.0-0.2.3 must be removed
    const old = new PlatformAccessory('Driveway', hap.uuid.generate('xfinityhome:xbo:1'), hap.Categories.IP_CAMERA);
    platform.configureAccessory(old);
    api.emit('didFinishLaunching');
    await waitFor(() => api.external.length >= 2 && platform.cameras.isFresh());
  });

  after(async () => {
    api.emit('shutdown');
    globalThis.fetch = realFetch;
    await fake.stop();
  });

  const cam = (name: string) => api.external.find(a => a.displayName === name)!;

  it('publishes both cameras as their own accessories, drops the old bridged copy, and never calls iControl', () => {
    assert.deepEqual(api.external.map(a => a.displayName).sort(), ['Back yard', 'Driveway']);
    assert.deepEqual(api.registered, [], 'nothing on the bridge');
    assert.deepEqual((api.unregistered as Array<{ displayName: string }>).map(a => a.displayName), ['Driveway']);
    assert.equal(cam('Driveway').category, hap.Categories.IP_CAMERA);
    assert.ok(cam('Driveway').getService(S.CameraRTPStreamManagement), 'has a camera stream service');
    assert.ok(cam('Driveway').getService(S.MotionSensor));
    assert.ok(!fake.requests.some(r => r.path.startsWith('/client/icontrol')), 'no 403-only iControl calls');
    assert.ok(logs.some(l => l.includes('camera-only mode')));
    assert.equal(cam('Driveway').getService(S.MotionSensor).getCharacteristic(C.MotionDetected).value, false);
  });

  it('serves a JPEG snapshot, and recovers when the signed thumbnail URL expires', async () => {
    const handler = (platform as unknown as { cameraHandlers: Map<string, { handleSnapshotRequest: Function }> })
      .cameraHandlers.get(cam('Back yard').UUID)!;
    const snap = () => new Promise<Buffer>((res, rej) =>
      handler.handleSnapshotRequest({ width: 640, height: 360 }, (e: Error | undefined, b: Buffer) => e ? rej(e) : res(b)));
    assert.deepEqual(await snap(), fake.jpeg);
    // new signed tokens: old cached URL now fails; the poller must re-fetch thumbnail URLs once
    fake.mediaToken = 'm2';
    (platform.cameras as unknown as { snapCache: Map<string, unknown> }).snapCache.clear();
    assert.deepEqual(await snap(), fake.jpeg);
    assert.ok(media.some(m => m.startsWith('livecache-read-cvr.sys.comcast.net/user/')), 'fetched from the media host');
  });

  it('turns on motion when a new recording appears, only for that camera', async () => {
    const m1 = cam('Driveway').getService(S.MotionSensor).getCharacteristic(C.MotionDetected);
    const m2 = cam('Back yard').getService(S.MotionSensor).getCharacteristic(C.MotionDetected);
    // profile links carry the media token, so refresh the profile (as the poller does every 10 min)
    (platform.cameras as unknown as { lastProfile: number }).lastProfile = 0;
    fake.camEvents[MAC1].push({ startTime: new Date().toISOString() });
    await platform.cameras.poll();
    assert.equal(m1.value, true);
    assert.equal(m2.value, false);
    assert.equal(await m1.handleGetRequest(), true);
    // same event again: no re-trigger bookkeeping problems, and still fresh
    await platform.cameras.poll();
    assert.ok(platform.cameras.isFresh());
  });

  it('reports No Response on motion when camera polling has been failing', async () => {
    const m2 = cam('Back yard').getService(S.MotionSensor).getCharacteristic(C.MotionDetected);
    (platform.cameras as unknown as { lastOk: number }).lastOk = Date.now() - 60 * 60_000;
    await assert.rejects(m2.handleGetRequest(), (e: number) => e === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await platform.cameras.poll();
    assert.equal(await m2.handleGetRequest(), false);
  });

  it('falls back to sending the app token when the events host rejects the signed link alone (the live 401)', async () => {
    const m2 = cam('Back yard').getService(S.MotionSensor).getCharacteristic(C.MotionDetected);
    fake.cvrNeedsBearer = true;
    platform.client.signedAuth.clear();
    fake.camEvents[MAC2] = [{ startTime: new Date().toISOString() }];
    await platform.cameras.poll();
    assert.equal(platform.client.signedAuth.get('playback-cvr.sys.comcast.net'), 'bearer');
    assert.equal(m2.value, true);
    assert.ok(logs.some(l => l.includes('recordings list reachable (signed link + app token')));
    // the snapshot host still works without credentials and keeps its own setting
    (platform.cameras as unknown as { snapCache: Map<string, unknown> }).snapCache.clear();
    await platform.cameras.snapshot('xbo:1');
    assert.equal(platform.client.signedAuth.get('livecache-read-cvr.sys.comcast.net'), 'none');
  });

  it('falls back to the latest recording still when the live picture fails, and says why in the log', async () => {
    const handler = (platform as unknown as { cameraHandlers: Map<string, { handleSnapshotRequest: Function }> })
      .cameraHandlers.get(cam('Driveway').UUID)!;
    const snap = () => new Promise<Buffer>((res, rej) =>
      handler.handleSnapshotRequest({ width: 640, height: 360 }, (e: Error | undefined, b: Buffer) => e ? rej(e) : res(b)));
    fake.liveThumbBroken = true;
    (platform.cameras as unknown as { snapCache: Map<string, unknown> }).snapCache.clear();
    await platform.cameras.poll(); // picks up the newest recording's still link
    assert.deepEqual(await snap(), fake.stillJpeg);
    assert.ok(logs.some(l => l.includes('snapshots: using the still from the latest recording') && l.includes('looks like JSON')));

    // both sources failing: HomeKit gets an error and the log says why, once
    (platform.cameras as unknown as { snapCache: Map<string, unknown> }).snapCache.clear();
    fake.mediaToken = 'm3'; // stored still link now stale
    await assert.rejects(snap());
    assert.ok(logs.some(l => l.startsWith('WARN') && l.includes('snapshot for "Driveway" failed') && l.includes('latest recording still: GET')));
    fake.liveThumbBroken = false;
  });

  it('streams the latest picture as SRTP video when a camera is opened (real ffmpeg)', async (t) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) {
      t.skip('ffmpeg not installed');
      return;
    }
    // a real JPEG so ffmpeg's MJPEG decoder is happy
    const jpg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240',
      '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']).stdout as Buffer;
    fake.jpeg = Buffer.from(jpg);
    fake.liveThumbBroken = false;
    fake.mediaToken = 'm1';
    (platform.cameras as unknown as { lastProfile: number }).lastProfile = 0;
    await platform.cameras.poll();
    (platform.cameras as unknown as { snapCache: Map<string, unknown>; liveBrokenUntil: number }).snapCache.clear();
    (platform.cameras as unknown as { liveBrokenUntil: number }).liveBrokenUntil = 0;

    // stand in for the iPhone: receive the RTP stream
    const phone = dgram.createSocket('udp4');
    await new Promise<void>(r => phone.bind(0, '127.0.0.1', () => r()));
    const packets: Buffer[] = [];
    phone.on('message', m => packets.push(m));

    const handler = (platform as unknown as { cameraHandlers: Map<string, {
      prepareStream: Function; handleStreamRequest: Function; }> }).cameraHandlers.get(cam('Back yard').UUID)!;
    const key = Buffer.alloc(16, 7);
    const salt = Buffer.alloc(14, 9);
    const prep = await new Promise<{ video: { port: number; ssrc: number }; audio?: { port: number } }>((res, rej) => handler.prepareStream({
      sessionID: 's1', sourceAddress: '127.0.0.1', targetAddress: '127.0.0.1', addressVersion: 'ipv4',
      video: { port: phone.address().port, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt },
      audio: { port: 1, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt },
    }, (e: Error | undefined, r: never) => e ? rej(e) : res(r)));
    assert.ok(prep.video.port > 0);
    assert.ok(prep.audio && prep.audio.port > 0, 'HAP throws "Audio was enabled but not supplied" without this');
    await new Promise<void>((res, rej) => handler.handleStreamRequest({ sessionID: 's1', type: 'start',
      video: { width: 640, height: 360, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 299, mtu: 1378, rtcp_interval: 0.5 },
      audio: {} }, (e?: Error) => e ? rej(e) : res()));
    t.after(() => {
      handler.handleStreamRequest({ sessionID: 's1', type: 'stop' }, () => undefined);
      try {
        phone.close();
      } catch {
        // closed
      }
    });
    const isRtcp = (b: Buffer) => b[1] >= 200 && b[1] <= 204; // SR/RR/SDES/BYE/APP share the port (rtcp-mux)
    await waitFor(() => packets.filter(b => !isRtcp(b)).length >= 5, 8_000);
    const rtp = packets.find(b => !isRtcp(b))!;
    assert.equal(rtp[0] >> 6, 2, 'RTP version 2');
    assert.equal(rtp[1] & 0x7f, 99, 'payload type HomeKit asked for');
    assert.equal(rtp.readUInt32BE(8), prep.video.ssrc >>> 0, 'our SSRC');
    assert.ok(logs.some(l => l.includes('live view started (640x360)')));

    // the camera's picture changes: with the 1 s default the stream picks it up within ~2 s
    const fetchesBefore = fake.requests.filter(r => r.path.endsWith('/thumbnail')).length;
    fake.jpeg = Buffer.from(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=red:size=320x240', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']).stdout as Buffer);
    await new Promise(r => setTimeout(r, 2_500));
    const fetched = fake.requests.filter(r => r.path.endsWith('/thumbnail')).length - fetchesBefore;
    assert.ok(fetched >= 2 && fetched <= 4, `about one picture per second while open (got ${fetched} in 2.5 s)`);

    await new Promise<void>(res => handler.handleStreamRequest({ sessionID: 's1', type: 'stop' }, () => res()));
    await new Promise(r => setTimeout(r, 300));
    const n = packets.length;
    await new Promise(r => setTimeout(r, 700));
    assert.equal(packets.length, n, 'stream stops when the viewer closes it');
    assert.ok(logs.some(l => /live view ended \(viewer closed it\): \d+ s watched, \d+ pictures fetched, picture changed 1 times/.test(l)),
      'reports how often the picture really changed');
  });

  it('accepts an iPhone-style SetupEndpoints write through HAP itself (catches HAP-level rejections)', async () => {
    const tlvLib = require(path.join(path.dirname(require.resolve('@homebridge/hap-nodejs')), 'lib/util/tlv.js'));
    const tlv = tlvLib.encode as (...a: unknown[]) => Buffer;
    const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
    const srtp = tlv(1, 0, 2, Buffer.alloc(16, 1), 3, Buffer.alloc(14, 2));
    const msg = tlv(
      1, Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
      3, tlv(1, 0, 2, Buffer.from('127.0.0.1'), 3, u16(50000), 4, u16(50002)),
      4, srtp, 5, srtp,
    ).toString('base64');
    const ch = cam('Driveway').getService(S.CameraRTPStreamManagement).getCharacteristic(C.SetupEndpoints);
    const conn = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', getLocalAddress: () => '127.0.0.1' });
    await ch.handleSetRequest(msg, conn);
    const resp = Buffer.from(String(await ch.handleGetRequest()), 'base64');
    const fields = tlvLib.decode(resp) as Record<number, Buffer>;
    assert.equal(fields[2][0], 0, 'SetupEndpoints status SUCCESS');
    // close the prepared (never started) session
    const handler = (platform as unknown as { cameraHandlers: Map<string, { handleStreamRequest: Function }> })
      .cameraHandlers.get(cam('Driveway').UUID)!;
    conn.emit('closed'); // like the iPhone hanging up: HAP stops and cleans the session
  });

  it('keeps tokens and signed URLs out of the log', () => {
    assert.ok(!logs.some(l => /rt-\d|at-\d|token=|rt-cam/.test(l)));
  });
});
