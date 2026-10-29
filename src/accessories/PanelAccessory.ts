import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ArmType, DeviceState } from '../model/normalize';
import type { AccessoryContext } from '../settings';
import type { XfinityPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

// HomeKit SecuritySystem values
const STAY = 0, AWAY = 1, NIGHT = 2, DISARMED = 3, TRIGGERED = 4;

interface Pending {
  target: number;
  armType: ArmType;
  timer: NodeJS.Timeout;
}

/**
 * Security panel. HomeKit only ever sees states Comcast has confirmed:
 * a requested target is held as "pending" until an event or refresh shows the
 * panel got there, and is reverted (with a log line saying why) if it doesn't.
 */
export class PanelAccessory extends BaseAccessory {
  private readonly service: Service;
  private pending?: Pending;
  static readonly CONFIRM_TIMEOUT_MS = 3 * 60_000;

  constructor(platform: XfinityPlatform, accessory: PlatformAccessory<AccessoryContext>, state: DeviceState) {
    super(platform, accessory, state);
    const C = this.Characteristic;
    this.service = this.getOrAdd(this.Service.SecuritySystem, 'Security System');

    const valid = platform.config.nightMode === 'disabled' ? [STAY, AWAY, DISARMED] : [STAY, AWAY, NIGHT, DISARMED];
    this.service.getCharacteristic(C.SecuritySystemTargetState)
      .setProps({ validValues: valid })
      .onGet(() => {
        this.assertAvailable();
        return this.targetState();
      })
      .onSet(v => this.setTarget(v));
    this.service.getCharacteristic(C.SecuritySystemCurrentState)
      .onGet(() => {
        this.assertAvailable();
        return this.currentState();
      });
    this.service.getCharacteristic(C.StatusTampered).onGet(() => this.tampered());
    this.service.getCharacteristic(C.StatusFault).onGet(() => (this.state.online ? 0 : 1));
    this.update();
  }

  // ---------- mapping ----------

  currentState(s: DeviceState = this.state): number {
    const status = s.panelStatus ?? 'ready';
    if (status === 'alarm' || status === 'faultAlarm') {
      return TRIGGERED;
    }
    if (status === 'entryDelay' && this.platform.config.entryDelayAsTriggered !== false) {
      return TRIGGERED;
    }
    if (status === 'arming') {
      return DISARMED; // exit delay: not protected yet; target already shows the mode
    }
    return armTypeToHk(s.armType ?? '');
  }

  targetState(): number {
    if (this.pending) {
      return this.pending.target;
    }
    return armTypeToHk(this.state.armType ?? '');
  }

  private tampered(): number {
    return this.state.troubles.includes('senTamp') ? 1 : 0;
  }

  // ---------- commands ----------

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const target = Number(value);
    const { HAPStatus } = this.api.hap;
    const pin = this.platform.config.pin?.trim();

    if (!pin) {
      this.log('warn', 'Cannot arm or disarm: no PIN set in the plugin config.');
      this.revertSoon();
      throw this.hapError(HAPStatus.INSUFFICIENT_AUTHORIZATION);
    }
    this.assertAvailable();

    const armType = this.hkToArmType(target);
    if (target === this.targetState() && !this.pending) {
      return; // already there
    }
    if (target !== DISARMED && this.state.panelStatus === 'notReady') {
      const open = this.platform.store.all()
        .filter(d => (d.kind === 'contact' || d.kind === 'motion') && d.faulted && !d.bypassed)
        .map(d => d.name);
      this.log('warn', `Not arming: the panel is not ready${open.length ? ` (open: ${open.join(', ')})` : ''}.`);
      this.revertSoon();
      throw this.hapError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    const links = this.state.links;
    try {
      if (target === DISARMED) {
        if (!links['panel/disarm']) {
          throw new Error('panel has no disarm link');
        }
        this.log('info', 'Disarming…');
        await this.platform.client.disarm(links['panel/disarm'], pin);
      } else {
        if (!links['panel/arm']) {
          throw new Error('panel has no arm link');
        }
        this.log('info', `Arming (${armType})…`);
        await this.platform.client.arm(links['panel/arm'], pin, armType as 'stay' | 'away' | 'night');
      }
    } catch (err) {
      this.log('error', `${target === DISARMED ? 'Disarm' : 'Arm'} failed: ${err instanceof Error ? err.message : err}`);
      this.clearPending();
      this.revertSoon();
      this.platform.sync.requestRefresh(0);
      throw this.hapError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // Command accepted: hold the target until the panel confirms it.
    this.clearPending();
    this.pending = {
      target,
      armType,
      timer: setTimeout(() => this.confirmTimeout(), PanelAccessory.CONFIRM_TIMEOUT_MS),
    };
    // Pull fresh state soon in case the event stream is slow.
    setTimeout(() => this.platform.sync.requestRefresh(0), 5_000);
  }

  private hkToArmType(target: number): ArmType {
    switch (target) {
      case STAY: return 'stay';
      case AWAY: return 'away';
      case NIGHT: return this.platform.config.nightMode === 'stay' ? 'stay' : 'night';
      default: return '';
    }
  }

  private confirmTimeout(): void {
    if (!this.pending) {
      return;
    }
    this.log('warn', `The panel did not confirm "${this.pending.armType || 'disarmed'}" within 3 minutes; showing its actual state.`);
    this.clearPending();
    this.update();
    this.platform.sync.requestRefresh(0);
  }

  private clearPending(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
  }

  /** After a rejected set, put HomeKit's target back to the real state. */
  private revertSoon(): void {
    setTimeout(() => this.service.updateCharacteristic(this.Characteristic.SecuritySystemTargetState, this.targetState()), 250);
  }

  // ---------- state push ----------

  protected update(previous?: DeviceState): void {
    const C = this.Characteristic;
    if (this.pending) {
      const confirmed = this.pending.armType === (this.state.armType ?? '') && this.state.panelStatus !== 'arming';
      const nowArming = this.pending.armType !== '' && this.state.panelStatus === 'arming';
      if (confirmed) {
        this.clearPending();
      } else if (!nowArming && previous && this.state.panelStatus !== previous.panelStatus
        && ['ready', 'notReady'].includes(this.state.panelStatus ?? '') && this.pending.armType !== '') {
        // Arming was cancelled or failed on the panel side.
        this.log('warn', `Arming did not complete (panel is ${this.state.panelStatus}).`);
        this.clearPending();
      }
    }
    const cur = this.currentState();
    if (previous && this.currentState(previous) !== cur) {
      const labels = ['Armed Stay', 'Armed Away', 'Armed Night', 'Disarmed', 'ALARM TRIGGERED'];
      this.log(cur === TRIGGERED ? 'warn' : 'info', labels[cur]);
    }
    this.service.updateCharacteristic(C.SecuritySystemTargetState, this.targetState());
    this.service.updateCharacteristic(C.SecuritySystemCurrentState, cur);
    this.service.updateCharacteristic(C.StatusTampered, this.tampered());
    this.service.updateCharacteristic(C.StatusFault, this.state.online ? 0 : 1);
  }

  override dispose(): void {
    this.clearPending();
    super.dispose();
  }
}

const armTypeToHk = (a: ArmType | string): number =>
  a === 'stay' ? STAY : a === 'away' ? AWAY : a === 'night' ? NIGHT : DISARMED;
