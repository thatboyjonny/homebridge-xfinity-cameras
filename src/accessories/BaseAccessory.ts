import type { API, Characteristic, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { DeviceState } from '../model/normalize';
import { safeName } from '../model/normalize';
import type { AccessoryContext } from '../settings';
import type { XfinityPlatform } from '../platform';

/**
 * Shared plumbing: accessory information, store subscription, and an honest
 * "No Response" when our data is stale instead of reporting old values.
 */
export abstract class BaseAccessory {
  protected readonly Service: typeof Service;
  protected readonly Characteristic: typeof Characteristic;
  protected readonly api: API;
  private readonly onStoreChange: (s: DeviceState) => void;

  constructor(
    protected readonly platform: XfinityPlatform,
    protected readonly accessory: PlatformAccessory<AccessoryContext>,
    protected state: DeviceState,
  ) {
    this.api = platform.api;
    this.Service = platform.api.hap.Service;
    this.Characteristic = platform.api.hap.Characteristic;

    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, state.manufacturer)
      .setCharacteristic(this.Characteristic.Model, state.model)
      .setCharacteristic(this.Characteristic.SerialNumber, state.serial)
      .setCharacteristic(this.Characteristic.FirmwareRevision, safeFirmware(state.firmware));

    this.onStoreChange = (s: DeviceState) => {
      if (s.id === this.state.id) {
        const prev = this.state;
        this.state = s;
        this.update(prev);
      }
    };
    platform.store.on('change', this.onStoreChange);
  }

  dispose(): void {
    this.platform.store.off('change', this.onStoreChange);
  }

  /** Push current state into HomeKit characteristics. */
  protected abstract update(previous?: DeviceState): void;

  /** Throw "No Response" when the device is offline or our data is stale. */
  protected assertAvailable(): void {
    if (!this.state.online || !this.platform.sync.isFresh()) {
      throw this.hapError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  protected hapError(status: number): HapStatusError {
    return new this.api.hap.HapStatusError(status);
  }

  protected getOrAdd(service: typeof Service.ContactSensor, name?: string, subtype?: string): Service {
    const existing = subtype ? this.accessory.getServiceById(service, subtype) : this.accessory.getService(service);
    const svc = existing ?? this.accessory.addService(service, name ?? safeName(this.state.name), subtype);
    svc.setCharacteristic(this.Characteristic.Name, name ?? safeName(this.state.name));
    return svc;
  }

  protected log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
    this.platform.log[level](`${safeName(this.state.name)}: ${msg}`);
  }
}

/** HomeKit firmware strings must look like x.y.z. */
const safeFirmware = (fw: string): string => {
  const m = fw.match(/\d+(\.\d+){0,2}/);
  return m ? m[0] : '0.0.0';
};
