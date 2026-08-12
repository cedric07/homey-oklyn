'use strict';

const Homey = require('homey');
const { OklynApi } = require('./lib/OklynApi');

const POLL_INTERVALS = [5, 10, 15];
const DEFAULT_POLL_INTERVAL = 5;

module.exports = class OklynApp extends Homey.App {

  async onInit() {
    this.log('Oklyn app has been initialized');

    this.homey.settings.on('set', (key) => {
      if (key === 'apiToken') {
        this.log('API token updated — refreshing devices');
        this.refreshAllDevices().catch((err) => this.error(err));
        return;
      }

      if (key === 'pollInterval') {
        this.log('Poll interval updated — rescheduling devices');
        this.rescheduleAllDevices().catch((err) => this.error(err));
      }
    });
  }

  getApiToken() {
    return String(this.homey.settings.get('apiToken') || '').trim();
  }

  getPollIntervalMinutes() {
    const raw = Number(this.homey.settings.get('pollInterval'));
    if (POLL_INTERVALS.includes(raw)) return raw;
    return DEFAULT_POLL_INTERVAL;
  }

  createApi(logger) {
    const token = this.getApiToken();
    if (!token) {
      throw new Error(this.homey.__('errors.missing_token'));
    }
    return new OklynApi(token, logger || this);
  }

  async refreshAllDevices() {
    const driver = this.homey.drivers.getDriver('oklyn');
    if (!driver) return;

    await Promise.all(driver.getDevices().map(async (device) => {
      if (typeof device.syncNow === 'function') {
        await device.syncNow();
      }
    }));
  }

  async rescheduleAllDevices() {
    const driver = this.homey.drivers.getDriver('oklyn');
    if (!driver) return;

    driver.getDevices().forEach((device) => {
      if (typeof device.reschedulePoll === 'function') {
        device.reschedulePoll();
      }
    });
  }

};
