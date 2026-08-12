'use strict';

const Homey = require('homey');

module.exports = class OklynDriver extends Homey.Driver {

  async onInit() {
    this.log('OklynDriver has been initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    this.homey.flow.getActionCard('set_pump_mode')
      .registerRunListener(async ({ device, mode }) => {
        await device.setPumpMode(mode);
      });

    const setAux = this.homey.flow.getActionCard('set_aux');
    setAux.registerRunListener(async ({ device, aux, state }) => {
      await device.setAuxSwitch(this._auxId(aux), state === 'on');
    });
    setAux.registerArgumentAutocompleteListener('aux', async (query, args) => {
      return this._autocompleteAux(args.device, query, { switchesOnly: true });
    });

    this.homey.flow.getConditionCard('filtration_running')
      .registerRunListener(async ({ device }) => {
        return device.getCapabilityValue('oklyn_filtration_running') === true;
      });

    this.homey.flow.getConditionCard('pump_mode_is')
      .registerRunListener(async ({ device, mode }) => {
        return device.getCapabilityValue('oklyn_pump_mode') === mode;
      });

    const auxIsOn = this.homey.flow.getConditionCard('aux_is_on');
    auxIsOn.registerRunListener(async ({ device, aux }) => {
      return device.isAuxOn(this._auxId(aux));
    });
    auxIsOn.registerArgumentAutocompleteListener('aux', async (query, args) => {
      return this._autocompleteAux(args.device, query, { switchesOnly: false });
    });

    this.homey.flow.getConditionCard('measure_status_is')
      .registerRunListener(async ({ device, measure, status }) => {
        return device.getMeasureStatus(measure) === status;
      });

    this.homey.flow.getConditionCard('measure_above')
      .registerRunListener(async ({ device, measure, value }) => {
        const current = device.getMeasureValue(measure);
        return typeof current === 'number' && current > Number(value);
      });

    this.homey.flow.getConditionCard('measure_below')
      .registerRunListener(async ({ device, measure, value }) => {
        const current = device.getMeasureValue(measure);
        return typeof current === 'number' && current < Number(value);
      });
  }

  _auxId(aux) {
    if (aux && typeof aux === 'object') return aux.id;
    return aux;
  }

  _autocompleteAux(device, query, { switchesOnly }) {
    if (!device) return [];

    const settings = device.getSettings();
    const q = String(query || '').toLowerCase().trim();
    const results = [];

    for (const aux of ['aux1', 'aux2']) {
      const mode = settings[`${aux}_mode`];
      if (!mode || mode === 'unused') continue;
      if (switchesOnly && mode !== 'switch') continue;

      const name = device._resolveAuxTitle(aux, settings);
      if (q && !String(name).toLowerCase().includes(q)) continue;
      results.push({ id: aux, name });
    }

    return results;
  }

  async onPairListDevices() {
    const token = this.homey.app.getApiToken();
    if (!token) {
      throw new Error(this.homey.__('pair.error_configure_settings'));
    }

    const api = this.homey.app.createApi(this);
    const devices = await api.getDevices();
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error(this.homey.__('pair.error_no_devices'));
    }

    const pairedIds = this.getDevices().map((device) => String(device.getData().id));

    return devices
      .filter((device) => !pairedIds.includes(String(device.id)))
      .map((device) => ({
        name: device.username || `Oklyn ${device.id}`,
        data: {
          id: String(device.id),
        },
        settings: {
          notify_danger: true,
          notify_warning: false,
          // Aux modes must be set manually (API has no interrupteur/régul/enabled flag).
          aux1_mode: 'unused',
          aux1_label: 'electrolyzer',
          aux1_custom_label: '',
          aux2_mode: 'unused',
          aux2_label: 'light',
          aux2_custom_label: '',
        },
      }));
  }

};
