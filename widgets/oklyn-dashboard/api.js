'use strict';

async function getDevice(homey, query) {
  const deviceId = query.deviceId || (Array.isArray(query.id) ? query.id[0] : query.id);
  const driver = homey.drivers.getDriver('oklyn');
  if (!driver) return null;

  if (!deviceId) {
    const devices = driver.getDevices();
    if (devices.length === 1) return devices[0];
    return null;
  }

  return driver.getDevices().find((device) => device.getId() === deviceId) || null;
}

function hasCapability(device, capabilityId) {
  return device.hasCapability(capabilityId);
}

module.exports = {
  async getStatus({ homey, query }) {
    const device = await getDevice(homey, query);
    if (!device) {
      return { error: 'no_device' };
    }

    const settings = device.getSettings();
    const capabilities = {};
    for (const capabilityId of device.getCapabilities()) {
      capabilities[capabilityId] = device.getCapabilityValue(capabilityId);
    }

    return {
      id: device.getId(),
      name: device.getName(),
      available: device.getAvailable(),
      unavailableMessage: device.getUnavailableMessage
        ? device.getUnavailableMessage()
        : null,
      settings: {
        aux1_mode: settings.aux1_mode,
        aux2_mode: settings.aux2_mode,
        aux1_title: device._resolveAuxTitle
          ? device._resolveAuxTitle('aux1', settings)
          : 'Aux 1',
        aux2_title: device._resolveAuxTitle
          ? device._resolveAuxTitle('aux2', settings)
          : 'Aux 2',
      },
      presence: {
        water: hasCapability(device, 'measure_temperature.water'),
        air: hasCapability(device, 'measure_temperature.air'),
        ph: hasCapability(device, 'measure_ph'),
        orp: hasCapability(device, 'measure_orp'),
        salt: hasCapability(device, 'measure_salt'),
        aux1: settings.aux1_mode && settings.aux1_mode !== 'unused',
        aux2: settings.aux2_mode && settings.aux2_mode !== 'unused',
      },
      statuses: device._measureStatuses || {},
      lastSyncAt: device._lastSyncAt || null,
      capabilities,
    };
  },

  async setPumpMode({ homey, query, body }) {
    const device = await getDevice(homey, query);
    if (!device) throw new Error('Device not found');
    await device.setPumpMode(body.mode);
    return module.exports.getStatus({ homey, query });
  },

  async setAux({ homey, query, body }) {
    const device = await getDevice(homey, query);
    if (!device) throw new Error('Device not found');
    await device.setAuxSwitch(body.aux, body.on === true);
    return module.exports.getStatus({ homey, query });
  },
};
