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

function auxMode(device, aux) {
  return device.getAuxMode ? device.getAuxMode(aux) : 'unused';
}

function auxTitle(device, aux) {
  if (device._resolveAuxTitle) {
    return device._resolveAuxTitle(aux);
  }
  return aux === 'aux2' ? 'Aux 2' : 'Aux 1';
}

module.exports = {
  async getStatus({ homey, query }) {
    const device = await getDevice(homey, query);
    if (!device) {
      return { error: 'no_device' };
    }

    const aux1Mode = auxMode(device, 'aux1');
    const aux2Mode = auxMode(device, 'aux2');
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
        aux1_mode: aux1Mode,
        aux2_mode: aux2Mode,
        aux1_title: auxTitle(device, 'aux1'),
        aux2_title: auxTitle(device, 'aux2'),
      },
      presence: {
        water: hasCapability(device, 'measure_temperature.water'),
        air: hasCapability(device, 'measure_temperature.air'),
        ph: hasCapability(device, 'measure_ph'),
        orp: hasCapability(device, 'measure_orp'),
        salt: hasCapability(device, 'measure_salt'),
        aux1: aux1Mode !== 'unused',
        aux2: aux2Mode !== 'unused',
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
