export interface WeightedNode { value: number }
export interface Tile<T> { node: T; x: number; y: number; width: number; height: number }

// Balanced binary treemap: proportional areas, deterministic ordering, no
// mutable layout state, and no DOM nodes for zero/unknown byte counts.
export function layoutTiles<T extends WeightedNode>(nodes: T[], width: number, height: number, x = 0, y = 0): Tile<T>[] {
  if (width <= 0 || height <= 0) return [];
  const positive = nodes.filter(node => Number.isFinite(node.value) && node.value > 0);
  const tiles: Tile<T>[] = [];
  function split(items: T[], left: number, top: number, w: number, h: number) {
    if (!items.length) return;
    if (items.length === 1) { tiles.push({ node: items[0], x: left, y: top, width: w, height: h }); return; }
    const total = items.reduce((sum, item) => sum + item.value, 0);
    let cut = 1;
    let first = items[0].value;
    while (cut < items.length - 1 && Math.abs(total / 2 - first - items[cut].value) < Math.abs(total / 2 - first)) first += items[cut++].value;
    const fraction = first / total;
    if (w >= h) {
      split(items.slice(0, cut), left, top, w * fraction, h);
      split(items.slice(cut), left + w * fraction, top, w * (1 - fraction), h);
    } else {
      split(items.slice(0, cut), left, top, w, h * fraction);
      split(items.slice(cut), left, top + h * fraction, w, h * (1 - fraction));
    }
  }
  split(positive, x, y, width, height);
  return tiles;
}

export function pieSlice(start: number, fraction: number, radius = 140, cx = 180, cy = 180) {
  const point = (angle: number) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  const angle = start * 2 * Math.PI - Math.PI / 2;
  const [sx, sy] = point(angle);
  if (fraction >= 1 - Number.EPSILON) {
    const [mx, my] = point(angle + Math.PI);
    return `M ${cx} ${cy} L ${sx} ${sy} A ${radius} ${radius} 0 1 1 ${mx} ${my} A ${radius} ${radius} 0 1 1 ${sx} ${sy} Z`;
  }
  const [ex, ey] = point(angle + fraction * 2 * Math.PI);
  return `M ${cx} ${cy} L ${sx} ${sy} A ${radius} ${radius} 0 ${fraction > .5 ? 1 : 0} 1 ${ex} ${ey} Z`;
}
