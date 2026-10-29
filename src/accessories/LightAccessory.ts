import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { DeviceState } from '../model/normalize';
import { safeName } from '../model/normalize';
import type { AccessoryContext } from '../settings';
import type { XfinityPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

/** Xfinity Z-Wave/Zigbee light switches and dimmers. */
export class LightAccessory extends BaseAccessory {
  private readonly service: Service;

  constructor(platform: XfinityPlatform, accessory: PlatformAccessory<AccessoryContext>, state: DeviceState) {
    super(platform, accessory, state);
    const C = this.Characteristic;
    this.service = this.getOrAdd(this.Service.Lightbulb, safeName(state.name));

    this.service.getCharacteristic(C.On)
      .onGet(() => {
        this.assertAvailable();
        return this.state.on ?? false;
      })
      .onSet(v => this.write('isOn', Boolean(v), { on: Boolean(v) }));

    if (state.dimmable && state.links.level) {
      this.service.getCharacteristic(C.Brightness)
        .onGet(() => {
          this.assertAvailable();
          return this.state.level ?? 100;
        })
        .onSet(v => this.write('level', Number(v), { level: Number(v), on: Number(v) > 0 }));
    } else if (this.service.testCharacteristic(C.Brightness)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(C.Brightness));
    }
    this.update();
  }

  private async write(link: 'isOn' | 'level', value: boolean | number, patch: Partial<DeviceState>): Promise<void> {
    const href = this.state.links[link];
    if (!href) {
      throw this.hapError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    try {
      await this.platform.client.updateDevice(href, value as CharacteristicValue as string | number | boolean);
      this.platform.store.patch(this.state.id, patch);
    } catch (err) {
      this.log('error', `Set ${link} failed: ${err instanceof Error ? err.message : err}`);
      this.platform.sync.requestRefresh(0);
      throw this.hapError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  protected update(): void {
    this.service.updateCharacteristic(this.Characteristic.On, this.state.on ?? false);
    if (this.state.dimmable && this.state.level !== undefined) {
      this.service.updateCharacteristic(this.Characteristic.Brightness, this.state.level);
    }
  }
}
