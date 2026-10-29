import type { RawDevice } from '../api/types';

export type DeviceKind = 'panel' | 'contact' | 'motion' | 'smoke' | 'leak' | 'light' | 'camera' | 'ignored' | 'unknown';
export type ArmType = '' | 'stay' | 'away' | 'night';

export interface DeviceState {
  id: string;
  /** stable identity for HomeKit UUIDs; same value the original plugin used */
  hardwareId: string;
  kind: DeviceKind;
  name: string;
  model: string;
  manufacturer: string;
  serial: string;
  firmware: string;
  online: boolean;
  troubles: string[];
  links: Record<string, string>;

  // sensors
  faulted?: boolean;
  bypassed?: boolean;
  temperatureC?: number;
  subtype?: string;

  // panel
  panelStatus?: string;
  armType?: ArmType;

  // light
  on?: boolean;
  level?: number;
  dimmable?: boolean;

  // camera (phase 2)
  videoCodec?: string;
  videoFormat?: string;
}

/** Touchscreen hub: shows up as an unknown device, nothing useful to expose. */
const IGNORED_MODELS = new Set(['TCHU1AL0']);

export function classify(raw: RawDevice): DeviceKind {
  const p = raw.properties ?? {};
  if (raw.model && IGNORED_MODELS.has(raw.model)) {
    return 'ignored';
  }
  switch (raw.deviceType) {
    case 'panel': return 'panel';
    case 'lightSwitch':
    case 'lightDimmer': return 'light';
    case 'camera': return 'camera';
    case 'peripheral': return 'ignored'; // keyfobs, keypads, routers, gateways
    case 'sensor':
      switch (p.sensorType) {
        case 'dryContact': return 'contact';
        case 'motion': return 'motion';
        case 'smoke': return 'smoke';
        case 'water': return 'leak';
      }
      if (p.type === 'door' || p.type === 'window') {
        return 'contact';
      }
      if (p.type === 'motion') {
        return 'motion';
      }
      return 'unknown';
    default:
      return 'unknown';
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Xfinity reports sensor temperature in hundredths of a degree Celsius. */
export const toCelsius = (raw: unknown): number | undefined => {
  const n = num(raw);
  return n === undefined ? undefined : Math.round(n) / 100;
};

export function normalize(raw: RawDevice): DeviceState {
  const kind = classify(raw);
  const p = raw.properties ?? {};
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw._links ?? {})) {
    if (v?.href) {
      links[k] = v.href;
    }
  }
  const label = str(p.label) || str(raw.name);
  const state: DeviceState = {
    id: raw.id,
    hardwareId: str(raw.hardwareId, raw.id),
    kind,
    name: kind === 'panel' ? 'Security System' : label || str(raw.model, 'Xfinity Device'),
    model: str(raw.model, 'Unknown'),
    manufacturer: str(raw.manufacturer, 'Xfinity'),
    serial: str(raw.serialNumber) || str(p.serialNumber) || raw.id,
    firmware: str(raw.firmwareVersion, '0'),
    online: raw.status === undefined || raw.status === 'online',
    troubles: (raw.trouble ?? []).map(t => t.name).filter(Boolean),
    links,
  };

  switch (kind) {
    case 'contact':
    case 'motion':
    case 'smoke':
    case 'leak':
      state.faulted = bool(p.isFaulted) ?? false;
      state.bypassed = bool(p.isBypassed) ?? false;
      state.temperatureC = toCelsius(p.temperature);
      state.subtype = str(p.type) || undefined;
      break;
    case 'panel':
      state.panelStatus = str(p.status, 'ready');
      state.armType = (str(p.armType) as ArmType) || '';
      break;
    case 'light':
      state.on = bool(p.isOn) ?? false;
      state.level = num(p.level);
      state.dimmable = raw.deviceType === 'lightDimmer' || bool(p.dimAllowed) === true;
      break;
    case 'camera':
      state.videoCodec = str(p.videoCodec) || undefined;
      state.videoFormat = str(p.videoFormat) || undefined;
      break;
  }
  return state;
}

/** HomeKit display names must start and end with a letter or number. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} '’.,&()-]/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned || 'Xfinity Device';
}
