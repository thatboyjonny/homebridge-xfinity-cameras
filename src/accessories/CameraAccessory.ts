import type {
  API, CameraController, CameraStreamingDelegate, HAP, PlatformAccessory, PrepareStreamCallback,
  PrepareStreamRequest, Service, SnapshotRequest, SnapshotRequestCallback, StreamingRequest, StreamRequestCallback,
} from 'homebridge';

import type { CameraInfo, CameraPoller } from '../cameras/CameraPoller';
import { DEFAULT_SLIDESHOW, SlideshowOptions, SlideshowSession } from '../cameras/SlideshowStream';
import { safeName } from '../model/normalize';
import type { AccessoryContext } from '../settings';

export interface LiveViewConfig {
  /** null = live view off (setting disabled or ffmpeg unusable) */
  slideshow: SlideshowOptions | null;
  /** why live view is off, for the log */
  offReason?: string;
}

interface PendingSession {
  session: SlideshowSession;
  address: string;
  ipv6: boolean;
  port: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
}

/**
 * An Xfinity camera in Apple Home: snapshots (tile + notifications), a motion sensor, and a
 * "slideshow" live view: tapping the tile streams the latest picture, refreshed every few seconds.
 * Real live video isn't possible: Comcast streams over its own WebRTC signalling.
 */
export class CameraAccessory implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private readonly motion: Service;
  private readonly hap: HAP;
  private resetTimer?: NodeJS.Timeout;
  private readonly onMotion: (id: string) => void;
  private askedForSnapshot = false;
  private refusedMotion = false;
  private announcedLive = false;
  private readonly sessions = new Map<string, PendingSession>();

  constructor(
    api: API,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
    private readonly cam: CameraInfo,
    private readonly poller: CameraPoller,
    private readonly log: (level: 'info' | 'warn' | 'debug', msg: string) => void,
    private readonly motionSeconds = 30,
    private readonly live: LiveViewConfig = { slideshow: null, offReason: 'not configured' },
  ) {
    this.hap = api.hap;
    const { Service: S, Characteristic: C } = this.hap;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Xfinity')
      .setCharacteristic(C.Model, cam.model)
      .setCharacteristic(C.SerialNumber, cam.serial)
      .setCharacteristic(C.FirmwareRevision, (cam.firmware.match(/^\d+(\.\d+){1,2}$/) ?? ['1.0.0'])[0]); // e.g. 'SCHC2AEW' is a model code, not a version

    // Same stream description as homebridge-ring, which Apple Home accepts in this home: the full
    // resolution list (incl. 320x240@15 that Apple Watch requires), Baseline 3.1, and real audio codecs.
    // Apple Home silently treats cameras with an incomplete description as unusable and never asks for pictures.
    this.controller = new this.hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30], [1280, 720, 30], [1024, 768, 30], [640, 480, 30], [640, 360, 30],
            [480, 360, 30], [480, 270, 30], [320, 240, 30], [320, 240, 15], [320, 180, 30],
          ],
          codec: { profiles: [this.hap.H264Profile.BASELINE], levels: [this.hap.H264Level.LEVEL3_1] },
        },
        audio: {
          codecs: [
            { type: this.hap.AudioStreamingCodecType.OPUS, samplerate: this.hap.AudioStreamingSamplerate.KHZ_8 },
            { type: this.hap.AudioStreamingCodecType.OPUS, samplerate: this.hap.AudioStreamingSamplerate.KHZ_16 },
            { type: this.hap.AudioStreamingCodecType.OPUS, samplerate: this.hap.AudioStreamingSamplerate.KHZ_24 },
          ],
        },
      },
    });
    accessory.configureController(this.controller);

    const name = safeName(cam.name);
    this.motion = accessory.getService(S.MotionSensor) ?? accessory.addService(S.MotionSensor, `${name} Motion`);
    this.motion.setCharacteristic(C.Name, `${name} Motion`);
    this.motion.updateCharacteristic(C.MotionDetected, false);
    this.motion.getCharacteristic(C.MotionDetected).onGet(() => {
      if (!this.poller.isFresh()) {
        if (!this.refusedMotion) {
          this.refusedMotion = true;
          this.log('warn', 'motion status unavailable (camera checks have been failing); Apple Home will show No Response');
        }
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return this.resetTimer !== undefined;
    });

    this.onMotion = (id: string) => {
      if (id === this.cam.id) {
        this.trigger();
      }
    };
    poller.on('motion', this.onMotion);
  }

  dispose(): void {
    this.poller.off('motion', this.onMotion);
    this.sessions.forEach(p => p.session.stop('shutting down'));
    clearTimeout(this.resetTimer);
  }

  private trigger(): void {
    const C = this.hap.Characteristic;
    this.log('debug', 'motion');
    clearTimeout(this.resetTimer);
    this.motion.updateCharacteristic(C.MotionDetected, true);
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      this.motion.updateCharacteristic(C.MotionDetected, false);
    }, this.motionSeconds * 1000);
    this.resetTimer.unref?.();
  }

  handleSnapshotRequest(req: SnapshotRequest, callback: SnapshotRequestCallback): void {
    if (!this.askedForSnapshot) {
      this.askedForSnapshot = true;
      this.log('info', `Apple Home asked for a picture (${req.width}x${req.height}).`);
    }
    this.poller.snapshot(this.cam.id).then(img => callback(undefined, img), err => {
      this.log('debug', `snapshot failed: ${err instanceof Error ? err.message : err}`);
      callback(err instanceof Error ? err : new Error(String(err)));
    });
  }

  prepareStream(req: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const opts = this.live.slideshow;
    if (!opts) {
      this.log('debug', `live view requested but it's off (${this.live.offReason})`);
      callback(new Error(`live view is off: ${this.live.offReason}`));
      return;
    }
    const ipv6 = req.addressVersion === 'ipv6';
    const session = new SlideshowSession(ipv6, () => this.poller.snapshot(this.cam.id, Math.max(0, opts.refreshMs - 200)),
      (reason, stats) => {
        this.sessions.delete(req.sessionID);
        this.log(stats === 'never started' ? 'debug' : 'info', `live view ended (${reason}): ${stats}.`);
      }, opts);
    session.bind().then(port => {
      const ssrc = this.hap.CameraController.generateSynchronisationSource();
      this.sessions.set(req.sessionID, {
        session, address: req.targetAddress, ipv6, port: req.video.port,
        srtpKey: req.video.srtp_key, srtpSalt: req.video.srtp_salt, ssrc,
      });
      // The camera advertises audio (Apple Home ignores cameras without it), so HAP requires an audio
      // answer too. No audio is ever sent; the port only receives Home's audio RTCP, which also counts
      // as "viewer still here".
      callback(undefined, {
        video: { port, ssrc, srtp_key: req.video.srtp_key, srtp_salt: req.video.srtp_salt },
        audio: { port, ssrc: this.hap.CameraController.generateSynchronisationSource(),
          srtp_key: req.audio.srtp_key, srtp_salt: req.audio.srtp_salt },
      });
    }, err => {
      session.stop('could not open a local port');
      callback(err instanceof Error ? err : new Error(String(err)));
    });
  }

  handleStreamRequest(req: StreamingRequest, callback: StreamRequestCallback): void {
    const p = this.sessions.get(req.sessionID);
    if (req.type === 'stop') {
      p?.session.stop('viewer closed it');
      callback();
      return;
    }
    if (req.type === 'reconfigure') {
      callback(); // a still picture doesn't need bitrate/size changes mid-stream
      return;
    }
    if (!p) {
      callback(new Error('unknown live view session'));
      return;
    }
    const v = req.video;
    p.session.start({
      address: p.address, ipv6: p.ipv6, port: p.port, srtpKey: p.srtpKey, srtpSalt: p.srtpSalt, ssrc: p.ssrc,
      payloadType: v.pt, width: v.width, height: v.height, fps: v.fps, maxBitrateKbps: v.max_bit_rate, mtu: v.mtu,
    }).then(() => {
      if (!this.announcedLive) {
        this.announcedLive = true;
        this.log('info', `live view started (${v.width}x${v.height}): showing the latest picture, refreshed every ` +
          `${Math.round((this.live.slideshow ?? DEFAULT_SLIDESHOW).refreshMs / 1000)} s.`);
      }
      callback();
    }, err => {
      this.log('warn', `live view failed to start: ${err instanceof Error ? err.message : err}`);
      p.session.stop('start failed');
      callback(err instanceof Error ? err : new Error(String(err)));
    });
  }
}
