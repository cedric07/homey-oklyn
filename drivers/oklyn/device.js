'use strict';

const Homey = require('homey');
const { OklynApi } = require('../../lib/OklynApi');

const MEASURE_CAPABILITY_MAP = {
  water: 'measure_temperature.water',
  air: 'measure_temperature.air',
  ph: 'measure_ph',
  orp: 'measure_orp',
  salt: 'measure_salt',
};

const ALARM_CAPABILITY_MAP = {
  ph: 'alarm_generic.ph',
  orp: 'alarm_generic.orp',
  salt: 'alarm_generic.salt',
};

const AUX_LABEL_KEYS = {
  light: 'settings.aux_label_light',
  heating: 'settings.aux_label_heating',
  electrolyzer: 'settings.aux_label_electrolyzer',
};

function auxOnoffId(aux) {
  return aux === 'aux2' ? 'onoff.aux2' : 'onoff.aux1';
}

function auxContactId(aux) {
  return aux === 'aux2' ? 'oklyn_aux_contact.aux2' : 'oklyn_aux_contact.aux1';
}

module.exports = class OklynDevice extends Homey.Device {

  async onInit() {
    this.log('OklynDevice has been initialized');
    this._pollTimeout = null;
    this._syncing = false;
    this._syncPromise = null;
    this._writing = false;
    this._lastSyncAt = null;

    const storedStatuses = this.getStoreValue('measureStatuses');
    this._measureStatuses = {
      water: null,
      air: null,
      ph: null,
      orp: null,
      salt: null,
      ...(storedStatuses && typeof storedStatuses === 'object' ? storedStatuses : {}),
    };

    // Drop legacy sync cache if present.
    await this.unsetStoreValue('lastSyncAt').catch(() => { });

    this.registerCapabilityListener('oklyn_pump_mode', async (value) => {
      await this.setPumpMode(value);
    });

    this.registerCapabilityListener('onoff.aux1', async (value) => {
      await this.setAuxSwitch('aux1', value);
    });

    this.registerCapabilityListener('onoff.aux2', async (value) => {
      await this.setAuxSwitch('aux2', value);
    });

    if (this.hasCapability('oklyn_filtration_state')) {
      await this.removeCapability('oklyn_filtration_state').catch(this.error);
    }

    await this._applyAuxCapabilities();
    await this.syncNow();
    this._schedulePoll();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((key) => key.startsWith('aux'))) {
      await this._applyAuxCapabilities(newSettings);
      await this._updateCapabilityTitles(newSettings);
    }
  }

  async onDeleted() {
    this._clearPoll();
  }

  getApi() {
    // Prefer app-level API key (shared by all Oklyn devices).
    // Fallback to legacy per-device store for already paired devices.
    let token = '';
    try {
      token = this.homey.app.getApiToken();
    } catch (err) {
      token = '';
    }

    if (!token) {
      token = String(this.getStoreValue('apiToken') || '').trim();
    }

    if (!token) {
      throw new Error(this.homey.__('errors.missing_token'));
    }

    return new OklynApi(token, this);
  }

  getOklynId() {
    return this.getData().id;
  }

  getMeasureValue(measure) {
    const capabilityId = MEASURE_CAPABILITY_MAP[measure];
    if (!capabilityId || !this.hasCapability(capabilityId)) {
      return null;
    }
    return this.getCapabilityValue(capabilityId);
  }

  getMeasureStatus(measure) {
    return this._measureStatuses[measure] || null;
  }

  isAuxOn(aux) {
    const settings = this.getSettings();
    const mode = aux === 'aux2' ? settings.aux2_mode : settings.aux1_mode;

    if (mode === 'switch') {
      const capabilityId = auxOnoffId(aux);
      return this.hasCapability(capabilityId) && this.getCapabilityValue(capabilityId) === true;
    }

    if (mode === 'regul') {
      const capabilityId = auxContactId(aux);
      return this.hasCapability(capabilityId) && this.getCapabilityValue(capabilityId) === true;
    }

    return false;
  }

  async setPumpMode(mode) {
    if (this._syncPromise) await this._syncPromise;
    this._writing = true;
    try {
      await this._setPumpMode(mode);
    } finally {
      this._writing = false;
    }
  }

  async _setPumpMode(mode) {
    const api = this.getApi();
    let result = await api.setPump(this.getOklynId(), mode);
    if (!result || typeof result !== 'object') {
      result = {};
    }

    const pump = {
      pump: result.pump || mode,
      status: result.status,
    };

    // PUT may omit status; keep the UI in sync immediately.
    if (!pump.status) {
      if (mode === 'on') pump.status = 'on';
      else if (mode === 'off') pump.status = 'off';
      else {
        try {
          const current = await api.getPump(this.getOklynId());
          if (current && current.status) pump.status = current.status;
          if (current && current.pump) pump.pump = current.pump;
        } catch (err) {
          this.error('Failed to refresh pump status after set:', err.message);
        }
      }
    }

    await this._applyPump(pump);
  }

  async setAuxSwitch(aux, on) {
    if (this._syncPromise) await this._syncPromise;
    this._writing = true;
    try {
      await this._setAuxSwitch(aux, on);
    } finally {
      this._writing = false;
    }
  }

  async _setAuxSwitch(aux, on) {
    const settings = this.getSettings();
    const mode = aux === 'aux2' ? settings.aux2_mode : settings.aux1_mode;
    if (mode !== 'switch') {
      throw new Error(this.homey.__('errors.aux_not_switchable'));
    }

    const apiKey = aux === 'aux2' ? 'aux2' : 'aux';
    const api = this.getApi();
    let result = await api.setAux(this.getOklynId(), apiKey, on ? 'on' : 'off');
    if (!result || typeof result !== 'object') {
      result = {};
    }

    // PUT may omit status; keep the UI in sync with the commanded value.
    const reported = result.status || result.aux || result.aux2;
    if (!reported) {
      result = {
        ...result,
        available: true,
        [apiKey]: on ? 'on' : 'off',
      };
    } else if (result.available === undefined) {
      result = { ...result, available: true };
    }

    await this._applyAux(aux, result, mode);
  }

  async syncNow() {
    if (this._syncPromise) return this._syncPromise;
    // Avoid overwriting optimistic UI mid-command; next poll will catch up.
    if (this._writing) return;

    this._syncPromise = (async () => {
      this._syncing = true;
      try {
        const api = this.getApi();
        const snapshot = await api.getSnapshot(this.getOklynId());
        await this.setAvailable();
        await this._applySnapshot(snapshot);
        this._lastSyncAt = new Date().toISOString();
      } catch (err) {
        this.error('Sync failed:', err.message);
        await this.setUnavailable(err.message);
      } finally {
        this._syncing = false;
      }
    })().finally(() => {
      this._syncPromise = null;
    });

    return this._syncPromise;
  }

  async _applySnapshot(snapshot) {
    const { measurements, pump, aux } = snapshot;

    for (const [type, capabilityId] of Object.entries(MEASURE_CAPABILITY_MAP)) {
      const data = measurements[type];
      if (!data || data.available === false) {
        // Salt is optional hardware: drop capabilities when absent.
        // Other measures: keep last value, but clear status/alarm so alerts don't stick.
        if (type === 'salt') {
          if (this.hasCapability(capabilityId)) {
            await this.removeCapability(capabilityId).catch(this.error);
          }
          if (ALARM_CAPABILITY_MAP[type] && this.hasCapability(ALARM_CAPABILITY_MAP[type])) {
            await this.removeCapability(ALARM_CAPABILITY_MAP[type]).catch(this.error);
          }
        }
        await this._handleMeasureStatus(type, null);
        continue;
      }

      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch(this.error);
      }

      if (typeof data.value === 'number') {
        await this._setCapabilityValue(capabilityId, data.value);
      }

      await this._handleMeasureStatus(type, data.status || null);
    }

    if (pump && !pump.error) {
      await this._applyPump(pump);
    }

    const settings = this.getSettings();
    await this._applyAux('aux1', aux.aux, settings.aux1_mode);
    await this._applyAux('aux2', aux.aux2, settings.aux2_mode);
  }

  async _applyPump(pump) {
    if (pump.pump && this.hasCapability('oklyn_pump_mode')) {
      await this._setCapabilityValue('oklyn_pump_mode', pump.pump);
    }

    if (pump.status && this.hasCapability('oklyn_filtration_running')) {
      const running = pump.status === 'on';
      const previous = this.getCapabilityValue('oklyn_filtration_running');
      await this._setCapabilityValue('oklyn_filtration_running', running);

      if (previous !== null && previous !== running) {
        const cardId = running ? 'filtration_started' : 'filtration_stopped';
        await this.homey.flow.getDeviceTriggerCard(cardId)
          .trigger(this)
          .catch(this.error);
      }
    }
  }

  async _applyAux(aux, data, mode) {
    if (!data || data.available === false) {
      await this._removeAuxCapabilities(aux);
      return;
    }

    const reported = data.status || data.aux || data.aux2;
    const isOn = reported === 'on';

    if (mode === 'unused') {
      await this._removeAuxCapabilities(aux);
      return;
    }

    const onoffId = auxOnoffId(aux);
    const contactId = auxContactId(aux);

    if (mode === 'switch') {
      if (this.hasCapability(contactId)) {
        await this.removeCapability(contactId).catch(this.error);
      }
      if (!this.hasCapability(onoffId)) {
        await this.addCapability(onoffId).catch(this.error);
        await this._updateCapabilityTitles();
      }
      // Skip UI update when API returned no usable state (avoid false OFF).
      if (reported) {
        await this._setCapabilityValue(onoffId, isOn);
      }
      return;
    }

    if (mode === 'regul') {
      if (this.hasCapability(onoffId)) {
        await this.removeCapability(onoffId).catch(this.error);
      }
      let added = false;
      if (!this.hasCapability(contactId)) {
        await this.addCapability(contactId).catch(this.error);
        added = true;
      }
      if (reported) {
        await this._setCapabilityValue(contactId, isOn);
      }
      if (added) {
        await this._updateCapabilityTitles();
      }
    }
  }

  async _handleMeasureStatus(type, status) {
    const previous = this._measureStatuses[type];
    this._measureStatuses[type] = status;

    if (previous !== status) {
      await this.setStoreValue('measureStatuses', { ...this._measureStatuses }).catch(this.error);
    }

    const alarmCapabilityId = ALARM_CAPABILITY_MAP[type];
    if (alarmCapabilityId) {
      const isAlarm = status === 'warning' || status === 'danger';
      if (!this.hasCapability(alarmCapabilityId) && type !== 'water' && type !== 'air') {
        // alarms only for ph/orp/salt in manifest; skip if measure missing
        if (MEASURE_CAPABILITY_MAP[type] && this.hasCapability(MEASURE_CAPABILITY_MAP[type])) {
          await this.addCapability(alarmCapabilityId).catch(this.error);
        }
      }
      if (this.hasCapability(alarmCapabilityId)) {
        await this._setCapabilityValue(alarmCapabilityId, isAlarm);
      }
    }

    if (previous === status || status === null) {
      return;
    }

    // Only trigger when status actually changes to warning/danger/normal
    if (!['normal', 'warning', 'danger'].includes(status)) {
      return;
    }

    // Skip Flow + notifications on first known value (incl. after restart with empty store).
    if (previous === null) {
      return;
    }

    await this.homey.flow.getDeviceTriggerCard('measure_status_changed')
      .trigger(this, {
        measure: type,
        status,
        value: this.getMeasureValue(type),
      })
      .catch(this.error);

    await this._maybeNotify(type, status);
  }

  async _maybeNotify(type, status) {
    const settings = this.getSettings();
    const shouldNotify = (status === 'danger' && settings.notify_danger)
      || (status === 'warning' && settings.notify_warning);

    if (!shouldNotify) return;

    const measureName = this.homey.__(`measures.${type}`);
    const statusName = this.homey.__(`status.${status}`);
    const value = this.getMeasureValue(type);
    const valueText = typeof value === 'number' ? String(value) : '—';

    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('notifications.measure_alert', {
        device: this.getName(),
        measure: measureName,
        status: statusName,
        value: valueText,
      }),
    }).catch(this.error);
  }

  async _applyAuxCapabilities(settings = this.getSettings()) {
    await this._applyAuxCapabilitySide('aux1', settings.aux1_mode);
    await this._applyAuxCapabilitySide('aux2', settings.aux2_mode);
    await this._updateCapabilityTitles(settings);
  }

  async _applyAuxCapabilitySide(aux, mode) {
    const onoffId = auxOnoffId(aux);
    const contactId = auxContactId(aux);

    if (mode === 'unused') {
      await this._removeAuxCapabilities(aux);
      return;
    }

    if (mode === 'switch') {
      if (this.hasCapability(contactId)) {
        await this.removeCapability(contactId).catch(this.error);
      }
      if (!this.hasCapability(onoffId)) {
        await this.addCapability(onoffId).catch(this.error);
      }
      return;
    }

    if (mode === 'regul') {
      if (this.hasCapability(onoffId)) {
        await this.removeCapability(onoffId).catch(this.error);
      }
      if (!this.hasCapability(contactId)) {
        await this.addCapability(contactId).catch(this.error);
      }
    }
  }

  async _removeAuxCapabilities(aux) {
    const onoffId = auxOnoffId(aux);
    const contactId = auxContactId(aux);
    if (this.hasCapability(onoffId)) {
      await this.removeCapability(onoffId).catch(this.error);
    }
    if (this.hasCapability(contactId)) {
      await this.removeCapability(contactId).catch(this.error);
    }
  }

  async _updateCapabilityTitles(settings = this.getSettings()) {
    const options = {};

    for (const aux of ['aux1', 'aux2']) {
      const mode = settings[`${aux}_mode`];
      const title = this._resolveAuxTitle(aux, settings);

      if (mode === 'switch') {
        const capabilityId = auxOnoffId(aux);
        if (this.hasCapability(capabilityId)) {
          options[capabilityId] = { title: { en: title, fr: title } };
        }
      }

      if (mode === 'regul') {
        const capabilityId = auxContactId(aux);
        if (this.hasCapability(capabilityId)) {
          options[capabilityId] = {
            title: { en: title, fr: title },
            titleTrue: { en: `${title} on`, fr: `${title} en marche` },
            titleFalse: { en: `${title} off`, fr: `${title} à l'arrêt` },
            insightsTitleTrue: { en: `${title} turned on`, fr: `${title} activé` },
            insightsTitleFalse: { en: `${title} turned off`, fr: `${title} désactivé` },
          };
        }
      }
    }

    const cached = this.getStoreValue('capabilitiesOptionsCache') || {};
    if (JSON.stringify(cached) !== JSON.stringify(options)) {
      await this.setStoreValue('capabilitiesOptionsCache', options).catch(this.error);
    }

    for (const [capabilityId, opts] of Object.entries(options)) {
      if (!this.hasCapability(capabilityId)) continue;
      await this.setCapabilityOptions(capabilityId, opts).catch(() => { });
    }
  }

  _resolveAuxTitle(aux, settings) {
    const custom = String(settings[`${aux}_custom_label`] || '').trim();
    if (custom) return custom;

    let labelId = settings[`${aux}_label`];
    if (!labelId || labelId === 'other' || !AUX_LABEL_KEYS[labelId]) {
      labelId = settings[`${aux}_mode`] === 'regul' || aux === 'aux1'
        ? 'electrolyzer'
        : 'light';
    }
    return this.homey.__(AUX_LABEL_KEYS[labelId]);
  }

  async _setCapabilityValue(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    const current = this.getCapabilityValue(capabilityId);
    if (current === value) return;
    await this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

  getPollIntervalMinutes() {
    return this.homey.app.getPollIntervalMinutes();
  }

  reschedulePoll() {
    this._schedulePoll();
  }

  _schedulePoll() {
    this._clearPoll();
    const minutes = this.getPollIntervalMinutes();
    const ms = minutes * 60 * 1000;

    this._pollTimeout = this.homey.setTimeout(async () => {
      await this.syncNow();
      this._schedulePoll();
    }, ms);
  }

  _clearPoll() {
    if (this._pollTimeout) {
      this.homey.clearTimeout(this._pollTimeout);
      this._pollTimeout = null;
    }
  }

};
