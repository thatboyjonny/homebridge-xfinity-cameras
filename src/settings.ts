export const PLATFORM_NAME = 'XfinityCameras';
export const PLUGIN_NAME = 'homebridge-xfinity-cameras';
/** Folder inside the Homebridge storage directory for the rotated token. */
export const STORAGE_DIR = 'xfinity-cameras';
/** Folders used by pre-release builds; a token found there is migrated once. */
export const LEGACY_STORAGE_DIRS = ['xfinityhome-local'];

export interface PluginConfig {
  platform: string;
  name?: string;
  /** Seed refresh token. After first use the rotated token lives in the token file. */
  refreshToken?: string;
  /** Xfinity keypad code, needed to arm and disarm. */
  pin?: string;
  /** Show HomeKit "Triggered" during the entry delay (default true). */
  entryDelayAsTriggered?: boolean;
  /** What HomeKit "Night" arms as: Xfinity night, Xfinity stay, or hide Night. */
  nightMode?: 'night' | 'stay' | 'disabled';
  /** Add a temperature sensor for sensors that report temperature (default false). */
  temperatureSensors?: boolean;
  /** Seconds between full refreshes (default 300, minimum 60). */
  refreshIntervalSeconds?: number;
  /** Use the real-time event stream (default true). */
  useEventStream?: boolean;
  /** Device names or ids to leave out of HomeKit. */
  hideDevices?: string[];
  cameras?: boolean;
  cameraMotionSeconds?: number;
  cameraPollSeconds?: number;
  liveView?: boolean;
  liveViewRefreshSeconds?: number;
  ffmpegPath?: string;
  /** Override endpoints if Comcast moves them again. */
  advanced?: { apiBase?: string; oauthUrl?: string };
}

export interface AccessoryContext {
  deviceId: string;
  kind: string;
}
