'use strict';

// Keep chart responses bounded independently of directory size. Work only on
// indexed metadata; this module never reads files or follows links.
const ROOT_LIMIT = 24;
const CHILD_LIMIT = 8;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compare = (a, b) => b.value - a.value || collator.compare(a.record.entry.name, b.record.entry.name) || a.record.entry.id - b.record.entry.id;

function offer(heap, candidate, limit) {
  if (heap.length === limit && compare(candidate, heap[0]) >= 0) return;
  if (heap.length < limit) {
    heap.push(candidate);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(heap[parent], heap[i]) >= 0) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  } else {
    heap[0] = candidate;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
      if (compare(heap[i], heap[child]) >= 0) break;
      [heap[i], heap[child]] = [heap[child], heap[i]];
      i = child;
    }
  }
}

function buildChartReport({ record, children, ancestors, scanId, scanState }, options) {
  const scope = record(options.entryId);
  if (!scope) throw new Error('ENTRY_UNAVAILABLE');
  const metric = options.metric;
  if (!['allocated', 'logical'].includes(metric)) throw new Error('INVALID_QUERY');
  const valueOf = node => metric === 'logical' ? node.entry.logicalSize : node.allocatedKnown;
  const build = (parent, limit, nested) => {
    const ids = parent.entry.kind === 'directory' ? children(parent.entry.id) : [parent.entry.id];
    const heap = [];
    let totalBytes = 0;
    let visibleBytes = 0;
    let visibleCount = 0;
    let hiddenBytes = 0;
    let hiddenCount = 0;
    for (const id of ids) {
      const child = record(id);
      const value = valueOf(child);
      totalBytes += value;
      if ((!options.includeHidden && child.entry.hiddenPath) || (!options.includeSystem && child.entry.systemPath)) {
        hiddenBytes += value; hiddenCount++;
      } else {
        visibleBytes += value; visibleCount++;
        offer(heap, { record: child, value }, limit);
      }
    }
    const largest = heap.sort(compare);
    const nodes = largest.map(({ record: child, value }) => ({
      key: `entry:${child.entry.id}`, group: 'entry', entry: { ...child.entry }, value, items: 1,
      ...(nested && child.entry.kind === 'directory' ? { children: build(child, CHILD_LIMIT, false).nodes } : {}),
    }));
    if (visibleCount > largest.length) nodes.push({
      key: `other:${parent.entry.id}`, group: 'other', entry: null,
      value: Math.max(0, visibleBytes - largest.reduce((sum, node) => sum + node.value, 0)), items: visibleCount - largest.length,
    });
    if (hiddenCount) nodes.push({ key: `hidden:${parent.entry.id}`, group: 'hidden', entry: null, value: hiddenBytes, items: hiddenCount });
    return { nodes, totalBytes, childCount: ids.length };
  };
  const result = build(scope, ROOT_LIMIT, true);
  return {
    scanId, scanState, metric, scope: { ...scope.entry }, ancestors: ancestors(scope.entry.id),
    ...result, unknownAllocatedEntries: scope.unknownAllocated,
    incomplete: scanState !== 'completed' || scope.entry.state !== 'ready',
    limits: { root: ROOT_LIMIT, children: CHILD_LIMIT, depth: 2 },
  };
}

module.exports = { buildChartReport, ROOT_LIMIT, CHILD_LIMIT };
