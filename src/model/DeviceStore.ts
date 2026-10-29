import { EventEmitter } from 'node:events';

import type { DeltaEvent, RawDevice } from '../api/types';
import { ArmType, DeviceState, normalize, toCelsius } from './normalize';

export interface StoreEvents {
  change: [state: DeviceState, previous: DeviceState | undefined];
  removed: [state: DeviceState];
}

const same = (a: DeviceState, b: DeviceState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Single in-memory source of truth for device state. Fed by full device-list
 * refreshes and by delta events; accessories subscribe to it and never hit the
 * network from HomeKit "get" handlers.
 */
export class DeviceStore extends EventEmitter<StoreEvents> {
  private readonly devices = new Map<string, DeviceState>();
  /** epoch ms of the last successful full refresh or event */
  lastUpdate = 0;

  constructor(private readonly now: () => number = Date.now) {
    super();
    this.setMaxListeners(0);
  }

  all(): DeviceState[] {
    return [...this.devices.values()];
  }

  get(id: string): DeviceState | undefined {
    return this.devices.get(id);
  }

  panel(): DeviceState | undefined {
    return this.all().find(d => d.kind === 'panel');
  }

  /** Replace state from a full device list. Returns ids that disappeared. */
  applySnapshot(raw: RawDevice[]): string[] {
    const seen = new Set<string>();
    for (const r of raw) {
      if (!r?.id) {
        continue;
      }
      seen.add(r.id);
      this.put(normalize(r));
    }
    const gone = [...this.devices.keys()].filter(id => !seen.has(id));
    for (const id of gone) {
      const s = this.devices.get(id)!;
      this.devices.delete(id);
      this.emit('removed', s);
    }
    this.lastUpdate = this.now();
    return gone;
  }

  /**
   * Apply one delta event. Returns false if the event was not understood,
   * so the caller can fall back to a full refresh.
   */
  applyEvent(event: DeltaEvent): boolean {
    const md = event.metadata ?? {};
    let target: DeviceState | undefined;
    if (event.mediaType === 'event/securityStateChange') {
      target = (event.deviceId && this.devices.get(event.deviceId)) || this.panel();
    } else if (event.deviceId) {
      target = this.devices.get(event.deviceId);
    }
    if (!target) {
      return false;
    }
    const next: DeviceState = { ...target, troubles: [...target.troubles] };

    switch (event.mediaType) {
      case 'event/securityStateChange':
        if (md.status) {
          next.panelStatus = md.status;
        }
        if (md.armType !== null && md.armType !== undefined) {
          next.armType = md.armType as ArmType;
        } else if (md.status === 'ready' || md.status === 'notReady') {
          next.armType = '';
        }
        break;
      case 'event/zone':
        if (event.name === 'isFaulted') {
          next.faulted = event.value === 'true';
        } else if (event.name === 'trouble' && event.value) {
          if (event.value.endsWith('Res')) {
            const cleared = event.value.slice(0, -3);
            next.troubles = next.troubles.filter(t => t !== cleared);
          } else if (!next.troubles.includes(event.value)) {
            next.troubles.push(event.value);
          }
        } else {
          return false;
        }
        if (md.sensorTemperature !== undefined && md.sensorTemperature !== null) {
          next.temperatureC = toCelsius(md.sensorTemperature) ?? next.temperatureC;
        }
        break;
      case 'event/zoneUpdated':
        if (md.isBypassed) {
          next.bypassed = md.isBypassed === 'true';
        }
        if (md.label) {
          next.name = md.label;
        }
        break;
      case 'event/lighting':
        if (md.isOn) {
          next.on = md.isOn === 'true';
        }
        if (md.level !== undefined && md.level !== null && md.level !== '') {
          const level = Number(md.level);
          if (Number.isFinite(level)) {
            next.level = level;
          }
        }
        break;
      default:
        return false;
    }
    this.put(next);
    this.lastUpdate = this.now();
    return true;
  }

  /** Optimistic local write after a confirmed command (e.g. light on). */
  patch(id: string, changes: Partial<DeviceState>): void {
    const cur = this.devices.get(id);
    if (cur) {
      this.put({ ...cur, ...changes });
    }
  }

  private put(next: DeviceState): void {
    const prev = this.devices.get(next.id);
    if (prev && same(prev, next)) {
      return;
    }
    this.devices.set(next.id, next);
    this.emit('change', next, prev);
  }
}
