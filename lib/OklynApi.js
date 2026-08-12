'use strict';

const BASE_URL = 'https://api.oklyn.fr/public/v1';

function createApiError(message, statusCode, body) {
  const error = new Error(message);
  error.name = 'OklynApiError';
  error.statusCode = statusCode;
  error.body = body;
  return error;
}

class OklynApi {

  /**
   * @param {string} token
   * @param {{ log?: Function, error?: Function }} [logger]
   */
  constructor(token, logger = {}) {
    this.token = token;
    this.log = logger.log || (() => {});
    this.error = logger.error || (() => {});
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  async request(method, path, body) {
    const url = `${BASE_URL}${path}`;
    const headers = {
      'X-API-TOKEN': this.token,
      Accept: 'application/json',
    };

    const options = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      throw createApiError(err.message || 'Network error');
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = text;
      }
    }

    if (!response.ok) {
      const message = (data && data.message) || `HTTP ${response.status}`;
      throw createApiError(message, response.status, data);
    }

    return data;
  }

  async getDevices() {
    return this.request('GET', '/devices');
  }

  /**
   * @param {string|number} deviceId
   * @param {'air'|'water'|'ph'|'orp'|'salt'} type
   */
  async getMeasurement(deviceId, type) {
    return this.request('GET', `/device/${deviceId}/data/${type}`);
  }

  /**
   * @param {string|number} deviceId
   */
  async getPump(deviceId) {
    return this.request('GET', `/device/${deviceId}/pump`);
  }

  /**
   * @param {string|number} deviceId
   * @param {'on'|'off'|'auto'} mode
   */
  async setPump(deviceId, mode) {
    return this.request('PUT', `/device/${deviceId}/pump`, { pump: mode });
  }

  /**
   * @param {string|number} deviceId
   * @param {'aux'|'aux2'} aux
   */
  async getAux(deviceId, aux) {
    return this.request('GET', `/device/${deviceId}/${aux}`);
  }

  /**
   * @param {string|number} deviceId
   * @param {'aux'|'aux2'} aux
   * @param {'on'|'off'} value
   */
  async setAux(deviceId, aux, value) {
    const body = aux === 'aux2' ? { aux2: value } : { aux: value };
    // API docs show { "aux": "on" } for both; try documented shape first.
    if (aux === 'aux2') {
      try {
        return await this.request('PUT', `/device/${deviceId}/aux2`, { aux: value });
      } catch (err) {
        return this.request('PUT', `/device/${deviceId}/aux2`, body);
      }
    }
    return this.request('PUT', `/device/${deviceId}/aux`, { aux: value });
  }

  /**
   * @param {Error} err
   */
  static isAuthError(err) {
    return err && (err.statusCode === 401 || err.statusCode === 403);
  }

  /**
   * Fetch all known endpoints for a device.
   * Salt / aux may be unavailable depending on hardware.
   * Auth errors (401/403) are rethrown so the device can go unavailable.
   * @param {string|number} deviceId
   */
  async getSnapshot(deviceId) {
    const measurementTypes = ['air', 'water', 'ph', 'orp', 'salt'];
    const measurements = {};
    let authError = null;

    await Promise.all(measurementTypes.map(async (type) => {
      try {
        measurements[type] = await this.getMeasurement(deviceId, type);
        measurements[type].available = true;
      } catch (err) {
        if (OklynApi.isAuthError(err)) {
          authError = err;
        }
        measurements[type] = {
          available: false,
          error: err.message,
          statusCode: err.statusCode,
        };
      }
    }));

    if (authError) {
      throw authError;
    }

    let pump = null;
    try {
      pump = await this.getPump(deviceId);
    } catch (err) {
      if (OklynApi.isAuthError(err)) {
        throw err;
      }
      pump = { error: err.message, statusCode: err.statusCode };
    }

    const aux = {};
    for (const key of ['aux', 'aux2']) {
      try {
        aux[key] = await this.getAux(deviceId, key);
        aux[key].available = true;
      } catch (err) {
        if (OklynApi.isAuthError(err)) {
          throw err;
        }
        aux[key] = {
          available: false,
          error: err.message,
          statusCode: err.statusCode,
        };
      }
    }

    return { measurements, pump, aux };
  }

}

module.exports = { OklynApi, createApiError };
