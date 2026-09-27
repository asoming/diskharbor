'use strict';

// Installed only by the opt-in performance harness in its isolated renderer.
// No production API, scheduling policy, sample or budget is changed.
function installRendererDiagnostics() {
  let active;
  const limit = 2048;
  const snapshot = () => ({
    status: document.querySelector('.scan-status')?.textContent,
    busy: document.querySelector('.fx-table')?.getAttribute('aria-busy'),
    direction: active?.column === undefined ? undefined
      : document.querySelectorAll('.fx-header [role="columnheader"]')[active.column]?.getAttribute('aria-sort'),
    first: document.querySelector('.fx-row .fx-filename')?.textContent,
    restoring: document.querySelector('.fx-search input')?.disabled,
    rows: document.querySelectorAll('.fx-row').length,
  });
  const append = (kind, detail = {}) => {
    if (!active || active.events.length >= limit) return;
    active.events.push({ kind, ms: performance.now() - active.started, ...detail });
  };
  const longTasks = entries => {
    for (const entry of entries) if (active && entry.startTime + entry.duration >= active.started) {
      append('long-task', { startMs: entry.startTime - active.started, durationMs: entry.duration, name: entry.name });
    }
  };
  let observer;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver(list => longTasks(list.getEntries()));
    observer.observe({ type: 'longtask' });
  }
  const mutations = new MutationObserver(() => {
    if (!active) return;
    const value = snapshot();
    const signature = JSON.stringify(value);
    if (signature !== active.signature) {
      active.signature = signature;
      append('dom', value);
    }
  });
  mutations.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['aria-busy', 'aria-sort', 'disabled'] });
  window.__diskharborPerformanceProbe = {
    begin(label, column) {
      if (active) throw new Error('A diagnostic action is already active.');
      active = { label, column, started: performance.now(), timeOrigin: performance.timeOrigin, events: [] };
      active.signature = JSON.stringify(snapshot());
      append('before-click', snapshot());
      const tick = () => {
        append('timer');
        active.timer = setTimeout(tick, 10);
      };
      const frame = stamp => {
        append('frame', { frameTimestampMs: stamp - active.started });
        active.frame = requestAnimationFrame(frame);
      };
      active.timer = setTimeout(tick, 10);
      active.frame = requestAnimationFrame(frame);
    },
    afterClick() { append('click-returned'); },
    finish() {
      if (!active) return null;
      clearTimeout(active.timer); cancelAnimationFrame(active.frame);
      if (observer) longTasks(observer.takeRecords());
      append('finished', snapshot());
      const result = { label: active.label, startedAtEpochMs: active.timeOrigin + active.started,
        durationMs: performance.now() - active.started, events: active.events,
        longTasksSupported: !!observer, capped: active.events.length >= limit };
      active = null;
      return result;
    },
  };
  return { longTasksSupported: !!observer, eventsPerActionLimit: limit };
}

module.exports = { installRendererDiagnostics };
