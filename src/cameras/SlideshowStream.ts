import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';

/** What HomeKit asked for in prepareStream + the START request, reduced to what ffmpeg needs. */
export interface SlideshowTarget {
  address: string;
  ipv6: boolean;
  port: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
  payloadType: number;
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
  mtu: number;
}

export interface SlideshowOptions {
  ffmpegPath: string;
  /** how often the picture is refreshed from Comcast */
  refreshMs: number;
  /** end the session if HomeKit stops sending RTCP for this long */
  idleTimeoutMs: number;
  /** hard cap on one viewing session */
  maxSessionMs: number;
}

export const DEFAULT_SLIDESHOW: SlideshowOptions = {
  ffmpegPath: 'ffmpeg', refreshMs: 1_000, idleTimeoutMs: 30_000, maxSessionMs: 10 * 60_000,
};

/** Check once whether ffmpeg exists and can do what HomeKit needs (libx264 + SRTP). */
export function checkFfmpeg(path: string): { ok: true } | { ok: false; reason: string } {
  const run = (args: string[]) => spawnSync(path, ['-hide_banner', ...args], { encoding: 'utf8', timeout: 10_000 });
  const v = run(['-version']);
  if (v.error || v.status !== 0) {
    return { ok: false, reason: `ffmpeg not found at "${path}"` };
  }
  if (!/\bsrtp\b/.test(run(['-protocols']).stdout ?? '')) {
    return { ok: false, reason: 'this ffmpeg build has no SRTP support' };
  }
  if (!/libx264/.test(run(['-encoders']).stdout ?? '')) {
    return { ok: false, reason: 'this ffmpeg build has no libx264 encoder' };
  }
  return { ok: true };
}

/** ffmpeg arguments: JPEGs on stdin -> H.264 Baseline -> SRTP to the iPhone/hub. */
export function ffmpegArgs(t: SlideshowTarget, inputFps = 2): string[] {
  const fps = Math.max(5, Math.min(t.fps || 15, 15)); // a still picture doesn't need 30 fps
  const kbps = Math.max(100, Math.min(t.maxBitrateKbps || 300, 800));
  const host = t.ipv6 ? `[${t.address}]` : t.address;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(inputFps), '-i', 'pipe:0',
    '-an', '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.1',
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-vf', `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease,pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2`,
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-payload_type', String(t.payloadType), '-ssrc', String(t.ssrc),
    '-f', 'rtp', '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', Buffer.concat([t.srtpKey, t.srtpSalt]).toString('base64'),
    `srtp://${host}:${t.port}?rtcpport=${t.port}&pkt_size=${Math.min(t.mtu || 1378, 1378)}`,
  ];
}

/**
 * One live-view session: a local UDP socket (the port we hand HomeKit, so its RTCP lands
 * somewhere and tells us the viewer is still there) plus an ffmpeg that turns the latest
 * snapshot into a video stream, refreshed every few seconds.
 */
export class SlideshowSession {
  readonly socket: dgram.Socket;
  private ffmpeg?: ChildProcessWithoutNullStreams;
  private frame?: Buffer;
  private feedTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private startedAt = 0;
  private fetches = 0;
  private changes = 0;
  private idleTimer?: NodeJS.Timeout;
  private capTimer?: NodeJS.Timeout;
  private stopped = false;
  private stderr = '';

  constructor(
    ipv6: boolean,
    private readonly getPicture: () => Promise<Buffer>,
    private readonly onEnd: (reason: string, stats: string) => void,
    private readonly opts: SlideshowOptions = DEFAULT_SLIDESHOW,
  ) {
    this.socket = dgram.createSocket(ipv6 ? 'udp6' : 'udp4');
    this.socket.on('error', () => undefined);
  }

  /** Bind the local port HomeKit will send RTCP to. */
  bind(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(0, () => resolve(this.socket.address().port));
    });
  }

  async start(target: SlideshowTarget): Promise<void> {
    this.frame = await this.getPicture(); // fail fast (HomeKit shows an error) if there's no picture at all
    const inputFps = 2;
    this.ffmpeg = spawn(this.opts.ffmpegPath, ffmpegArgs(target, inputFps), { stdio: ['pipe', 'ignore', 'pipe'] }) as
      unknown as ChildProcessWithoutNullStreams;
    this.ffmpeg.stderr.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-500)));
    this.ffmpeg.stdin.on('error', () => undefined);
    this.ffmpeg.on('error', err => this.stop(`could not run ffmpeg: ${err.message}`)); // e.g. removed after start-up
    this.ffmpeg.on('exit', (code, signal) => {
      if (!this.stopped) {
        this.stop(`ffmpeg exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`);
      }
    });
    const feed = () => {
      if (this.frame && this.ffmpeg?.stdin.writable) {
        this.ffmpeg.stdin.write(this.frame);
      }
    };
    feed();
    this.feedTimer = setInterval(feed, 1000 / inputFps);
    this.startedAt = Date.now();
    // fetch the next picture only after the previous one finished, so a slow Comcast reply
    // never piles up requests; on errors keep showing the last picture
    const refresh = () => {
      if (this.stopped) {
        return;
      }
      const began = Date.now();
      this.getPicture().then(f => {
        this.fetches++;
        if (this.frame && !f.equals(this.frame)) {
          this.changes++;
        }
        this.frame = f;
      }, () => undefined).finally(() => {
        if (!this.stopped) {
          this.refreshTimer = setTimeout(refresh, Math.max(0, this.opts.refreshMs - (Date.now() - began)));
        }
      });
    };
    this.refreshTimer = setTimeout(refresh, this.opts.refreshMs);
    this.socket.on('message', () => this.touch());
    this.touch();
    this.capTimer = setTimeout(() => this.stop('session time limit reached'), this.opts.maxSessionMs);
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('viewer went away (no RTCP)'), this.opts.idleTimeoutMs);
  }

  stop(reason = 'stopped'): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.feedTimer);
    [this.refreshTimer, this.idleTimer, this.capTimer].forEach(t => clearTimeout(t));
    try {
      this.ffmpeg?.stdin.end();
      this.ffmpeg?.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      this.socket.close();
    } catch {
      // already closed
    }
    this.onEnd(reason, this.stats());
  }

  /** How often Comcast's picture actually changed while someone watched (the real refresh ceiling). */
  stats(): string {
    if (!this.startedAt) {
      return 'never started';
    }
    const secs = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    return `${secs} s watched, ${this.fetches} pictures fetched, picture changed ${this.changes} times` +
      (this.changes ? ` (about every ${Math.max(1, Math.round(secs / this.changes))} s)` : '');
  }
}
