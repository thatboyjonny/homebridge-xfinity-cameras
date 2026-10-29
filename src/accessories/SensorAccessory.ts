import type { CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { DeviceState } from '../model/normalize';
import { safeName } from '../model/normalize';
import type { AccessoryContext } from '../settings';
import type { XfinityPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

/** Contact, motion, smoke and leak sensors share one implementation. */
export class SensorAccessory extends BaseAccessory {
  private readonly service: Service;
  private temperature?: Service;
  private readonly primary: WithUUID<new () => unknown> & { UUID: string };

  constructor(platform: XfinityPlatform, accessory: PlatformAccessory<AccessoryContext>, state: DeviceState) {
    super(platform, accessory, state);
    const S = this.Service, C = this.Characteristic;

    const spec = {
      contact: { svc: S.ContactSensor, ch: C.ContactSensorState },
      motion: { svc: S.MotionSensor, ch: C.MotionDetected },
      smoke: { svc: S.SmokeSensor, ch: C.SmokeDetected },
      leak: { svc: S.LeakSensor, ch: C.LeakDetected },
    }[state.kind as 'contact' | 'motion' | 'smoke' | 'leak'];
    if (!spec) {
      throw new Error(`SensorAccessory cannot handle kind ${state.kind}`);
    }
    this.primary = spec.ch as never;
    this.service = this.getOrAdd(spec.svc, safeName(state.name));

    this.service.getCharacteristic(spec.ch).onGet(() => {
      this.assertAvailable();
      return this.primaryValue();
    });
    this.service.getCharacteristic(C.StatusActive).onGet(() => !this.state.bypassed);
    this.service.getCharacteristic(C.StatusTampered).onGet(() => this.tampered());
    this.service.getCharacteristic(C.StatusLowBattery).onGet(() => this.lowBattery());
    this.service.getCharacteristic(C.StatusFault).onGet(() => this.fault());

    this.syncTemperatureService();
    this.update();
  }

  private primaryValue(): CharacteristicValue {
    // For every one of these HomeKit types, 1 means open / detected.
    return this.state.faulted ? 1 : (this.state.kind === 'motion' ? false : 0);
  }

  private tampered(): number {
    return this.state.troubles.includes('senTamp') ? 1 : 0;
  }

  private lowBattery(): number {
    return this.state.troubles.some(t => t === 'senLowBat' || t === 'senPreLowBat') ? 1 : 0;
  }

  private fault(): number {
    return !this.state.online || this.state.troubles.includes('senLowBat') ? 1 : 0;
  }

  private syncTemperatureService(): void {
    const want = this.platform.config.temperatureSensors === true && this.state.temperatureC !== undefined;
    const existing = this.accessory.getService(this.Service.TemperatureSensor);
    if (want && !existing) {
      this.temperature = this.accessory.addService(this.Service.TemperatureSensor, `${safeName(this.state.name)} Temperature`);
    } else if (!want && existing) {
      this.accessory.removeService(existing);
    } else {
      this.temperature = existing;
    }
    this.temperature?.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => {
        this.assertAvailable();
        return this.state.temperatureC ?? 0;
      });
  }

  protected update(previous?: DeviceState): void {
    const C = this.Characteristic;
    const value = this.primaryValue();
    if (previous && previous.faulted !== this.state.faulted) {
      const words = {
        contact: ['closed', 'opened'], motion: ['clear', 'motion detected'],
        smoke: ['clear', 'SMOKE DETECTED'], leak: ['dry', 'LEAK DETECTED'],
      }[this.state.kind as 'contact'];
      this.log(this.state.faulted && (this.state.kind === 'smoke' || this.state.kind === 'leak') ? 'warn' : 'debug',
        words[this.state.faulted ? 1 : 0]);
    }
    this.service.updateCharacteristic(this.primary as never, value);
    this.service.updateCharacteristic(C.StatusActive, !this.state.bypassed);
    this.service.updateCharacteristic(C.StatusTampered, this.tampered());
    this.service.updateCharacteristic(C.StatusLowBattery, this.lowBattery());
    this.service.updateCharacteristic(C.StatusFault, this.fault());
    if (this.temperature && this.state.temperatureC !== undefined) {
      this.temperature.updateCharacteristic(C.CurrentTemperature, this.state.temperatureC);
    }
  }
}
