'use strict';
const { nativePaths, ensureNativePolicy } = require('./native-metadata.cjs');

const RESTART_FLAG = '--diskharbor-elevated-restart=';
function createWindowsPermissions({ platform = process.platform, packaged, app, load = require, installPolicy = ensureNativePolicy }) {
  const native = () => load(nativePaths('win32').policy);
  let pending = false;
  let restarting = false;
  const state = () => {
    if (platform !== 'win32') return { elevated: null, canRequestElevation: false };
    let elevated = null;
    try { const value = native().elevationStatus(); if (typeof value === 'boolean') elevated = value; } catch { /* Unknown never means authorized. */ }
    return { elevated, canRequestElevation: packaged === true && elevated === false && !pending };
  };
  const resume = argv => {
    if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new Error('ELEVATION_RESTART_FAILED');
    const flags = argv.filter(arg => arg.startsWith(RESTART_FLAG));
    if (!flags.length) return;
    const match = flags[0].slice(RESTART_FLAG.length).match(/^([1-9]\d{0,9}):([a-fA-F0-9]{32})$/);
    if (platform !== 'win32' || packaged !== true || flags.length !== 1 || !match ||
        Number(match[1]) > 0xffffffff || state().elevated !== true) throw new Error('ELEVATION_RESTART_FAILED');
    // A native initialization failure must not acknowledge readiness or cause
    // the original instance to give up its scan and single-instance lock.
    try {
      if (installPolicy() !== true) throw new Error('ELEVATION_RESTART_FAILED');
      if (native().waitForRestartParent(Number(match[1]), match[2]) !== true) throw new Error('ELEVATION_RESTART_FAILED');
    } catch { throw new Error('ELEVATION_RESTART_FAILED'); }
  };
  const restart = async () => {
    if (pending) throw new Error('ELEVATION_IN_PROGRESS');
    if (!state().canRequestElevation) throw new Error('ELEVATION_UNAVAILABLE');
    pending = true;
    let quitting = false;
    let rollbackConfirmed = true;
    try {
      const ready = await native().restartElevated();
      if (ready === false) return { started: false };
      if (ready !== true) throw new Error('ELEVATION_FAILED');
      rollbackConfirmed = false;
      // Native success means the elevated child installed its policy, signalled
      // readiness, and is now waiting for this exact process to terminate.
      let released = false;
      restarting = true;
      try {
        app.releaseSingleInstanceLock();
        released = true;
        app.quit();
      } catch (error) {
        restarting = false;
        // A ready child must be cancelled before it could mistake a later
        // ordinary parent exit for permission to take over the profile.
        try { rollbackConfirmed = native().cancelElevatedRestart() === true; }
        finally { if (released) app.requestSingleInstanceLock(); }
        if (!rollbackConfirmed) throw new Error('ELEVATION_FAILED');
        throw error;
      }
      quitting = true;
      return { started: true };
    } finally {
      // An unconfirmed cancellation must not reopen the close/restart gate.
      if (!quitting && rollbackConfirmed) pending = false;
    }
  };
  return { state, resume, restart, get pending() { return pending; }, get restarting() { return restarting; } };
}
module.exports = { createWindowsPermissions };
