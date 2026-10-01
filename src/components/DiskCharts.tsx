import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, BarChart3, ChevronRight, FolderTree, Info, LoaderCircle, PieChart, RefreshCw } from 'lucide-react';
import type { ChartMetric, ChartNode, ChartReport, DiskHarborAPI, Entry, Summary, ViewVisibility } from '../types';
import { layoutTiles, pieSlice } from '../chart-layout';
import { errorText } from '../errors';
import './disk-charts.css';

type ChartType = 'pie' | 'bar' | 'treemap';
const colors = ['#7ab5b0', '#8fb0d2', '#b3a0ce', '#d6ad7d', '#85bca0', '#c797ab', '#bdb371', '#88aab9'];
function color(node: ChartNode) {
  if (node.group !== 'entry') return node.group === 'hidden' ? '#c1c9cc' : '#d8e0df';
  let hash = 0;
  for (const char of node.entry!.path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return colors[(hash >>> 0) % colors.length];
}

export function DiskCharts({ api, summary, locale, visibility, disabled, formatSize, onOpen }: {
  api: DiskHarborAPI; summary: Summary; locale: 'zh-CN' | 'en'; visibility: ViewVisibility; disabled: boolean;
  formatSize: (bytes: number) => string; onOpen: (entry: Entry) => void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [scopeId, setScopeId] = useState(summary.rootId);
  const [metric, setMetric] = useState<ChartMetric>('allocated');
  const [type, setType] = useState<ChartType>('treemap');
  const [nested, setNested] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; report?: ChartReport; error?: unknown }>();
  const [hovered, setHovered] = useState<ChartNode>();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnLoad = useRef(false);
  const key = JSON.stringify([summary.scanId, scopeId, metric, visibility.includeHidden, visibility.includeSystem, refresh]);
  const report = result?.key === key ? result.report : undefined;
  const error = result?.key === key ? result.error : undefined;
  useLayoutEffect(() => {
    if (report && focusOnLoad.current) {
      focusOnLoad.current = false;
      heading.current?.focus();
    }
  }, [report]);
  const percent = (value: number) => {
    const ratio = report?.totalBytes ? value / report.totalBytes : 0;
    return ratio > 0 && ratio < .001 ? '<0.1%' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
  };
  const name = (node: ChartNode) => node.entry?.name || (node.group === 'hidden' ? t('已收起项目', 'Hidden by display settings') : t('其余项目', 'Remaining items'));
  const label = (node: ChartNode) => `${name(node)} · ${formatSize(node.value)} · ${percent(node.value)}${node.entry ? ` · ${node.entry.path}` : ` · ${node.items.toLocaleString(locale)} ${t('项', 'items')}`}`;
  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api.chart(summary.scanId, { entryId: scopeId, metric, includeHidden: visibility.includeHidden, includeSystem: visibility.includeSystem });
        if (alive && value.scanId === summary.scanId) {
          setResult({ key, report: value });
        }
      } catch (failure) { if (alive) setResult({ key, error: failure }); }
      finally { pending = false; }
    };
    setHovered(undefined);
    void load();
    const timer = summary.state === 'scanning' ? setInterval(load, 1500) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [api, key, summary.state]);

  const enter = (id: number) => {
    if (disabled || id === scopeId) return;
    focusOnLoad.current = true;
    setScopeId(id);
  };
  const activate = (node: ChartNode) => {
    if (disabled || !node.entry) return;
    if (node.entry.kind === 'directory') enter(node.entry.id);
    else onOpen(node.entry);
  };
  const interaction = (node: ChartNode) => ({
    role: node.entry ? 'button' : 'img', tabIndex: node.entry && !disabled ? 0 : undefined,
    'aria-label': label(node), 'aria-disabled': node.entry ? disabled : undefined,
    onMouseEnter: () => setHovered(node), onFocus: () => setHovered(node),
    onClick: () => activate(node),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(node); }
    },
  });
  const positive = report?.nodes.filter(node => node.value > 0) || [];
  let cumulative = 0;
  const tiles = layoutTiles(positive, 900, 460);
  const max = Math.max(0, ...positive.map(node => node.value));
  const selected = hovered && report?.nodes.some(node => node.key === hovered.key || node.children?.some(child => child.key === hovered.key)) ? hovered : undefined;

  return <section className="panel disk-charts" aria-label={t('空间图表', 'Storage charts')}>
    <div className="chart-toolbar">
      <div className="chart-switch" role="group" aria-label={t('图表类型', 'Chart type')}>
        {([
          ['treemap', FolderTree, t('面积树图', 'Treemap')], ['pie', PieChart, t('饼图', 'Pie')], ['bar', BarChart3, t('条形图', 'Bar')],
        ] as const).map(([value, Icon, title]) => <button key={value} aria-pressed={type === value} onClick={() => setType(value)}><Icon size={16} />{title}</button>)}
      </div>
      <label className="chart-metric">{t('统计口径', 'Measure')}<select value={metric} onChange={event => setMetric(event.target.value as ChartMetric)}>
        <option value="allocated">{t('磁盘占用', 'Allocated space')}</option><option value="logical">{t('文件内容大小', 'Logical size')}</option>
      </select></label>
    </div>
    {report && <>
      <nav className="chart-breadcrumbs" aria-label={t('图表位置', 'Chart location')}>
        {[...report.ancestors, report.scope].map((entry, index) => <span key={entry.id}>
          {index > 0 && <ChevronRight size={13} />}<button title={entry.path} aria-current={entry.id === scopeId ? 'location' : undefined} disabled={disabled} onClick={() => enter(entry.id)}>{entry.name || entry.path}</button>
        </span>)}
      </nav>
      <div className="chart-heading"><div><h2 ref={heading} tabIndex={-1}>{report.scope.name || report.scope.path}</h2><p>{metric === 'allocated' ? t('已知磁盘占用', 'Known allocated space') : t('文件内容大小', 'Logical size')}<strong>{formatSize(report.totalBytes)}</strong><span>· {report.childCount.toLocaleString(locale)} {t('个直属项目', 'direct items')}</span></p></div>
        <div className="chart-actions">{report.ancestors.length > 0 && <button className="button small secondary" disabled={disabled} onClick={() => enter(report.ancestors.at(-1)!.id)}><ArrowUp size={14} />{t('上一级', 'Up')}</button>}
          <button className="button small secondary" disabled={disabled} onClick={() => onOpen(report.scope)}><FolderTree size={14} />{t('在文件树中查看', 'View in file tree')}</button>
          <button className="icon-btn" aria-label={t('刷新图表', 'Refresh chart')} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>
        </div>
      </div>
      <p className="chart-explanation"><Info size={14} />{t('点击文件夹下钻，点击文件定位。占比含收起项目。', 'Open folders to drill down, or files to locate them. Shares include hidden items.')}</p>
      {(report.incomplete || metric === 'allocated' && report.unknownAllocatedEntries > 0) && <p className="chart-warning" role="status">{t('这是部分统计，未读取或未知占用没有按 0 大小补算。', 'These totals are partial. Unread or unknown sizes have not been assumed to be zero.')} {metric === 'allocated' && report.unknownAllocatedEntries > 0 && t(`${report.unknownAllocatedEntries} 项占用未知。`, `${report.unknownAllocatedEntries} entries have unknown allocated sizes.`)}</p>}
      <div className="chart-area" data-chart-type={type}>
        {!positive.length ? <div className="chart-empty"><FolderTree size={32} /><p>{t('没有可绘制的已知字节', 'No known bytes to draw')}</p><small>{t('空文件和未知项目仍可在下方明细中查看。', 'Zero-byte and unknown entries remain in the details below.')}</small></div> : type === 'pie' ? <svg className="chart-pie" viewBox="0 0 360 360" role="group" aria-label={t('目录占用饼图', 'Directory usage pie chart')}>
          {positive.map(node => { const start = cumulative; cumulative += node.value / report.totalBytes; return <path key={node.key} d={pieSlice(start, node.value / report.totalBytes)} fill={color(node)} className={`chart-slice ${node.entry ? 'interactive' : ''}`} {...interaction(node)}><title>{label(node)}</title></path>; })}
        </svg> : type === 'bar' ? <div className="chart-bars" role="group" aria-label={t('目录占用条形图', 'Directory usage bar chart')}>
          <div className="chart-axis"><span>0 B</span><span>{formatSize(max / 2)}</span><span>{formatSize(max)}</span></div>
          {positive.map(node => <button className="chart-bar" key={node.key} disabled={disabled || !node.entry} aria-label={label(node)} onClick={() => activate(node)} onFocus={() => setHovered(node)} onMouseEnter={() => setHovered(node)}>
            <span className="chart-bar-name" title={node.entry?.path}>{name(node)}</span><span className="chart-bar-track"><i style={{ width: `${node.value / max * 100}%`, background: color(node) }} /></span><b>{formatSize(node.value)}<small>{percent(node.value)}</small></b>
          </button>)}
        </div> : <div className="chart-treemap-wrap"><label className="chart-nested"><input type="checkbox" checked={nested} onChange={event => setNested(event.target.checked)} />{t('显示下一层', 'Show next level')}</label>
          <svg className="chart-treemap" viewBox="0 0 900 460" role="group" aria-label={t('目录层级面积树图', 'Directory hierarchy treemap')}>
            {tiles.map(tile => {
              const { node, x, y, width, height } = tile;
              const children = nested && width > 70 && height > 60 ? layoutTiles(node.children || [], Math.max(0, width - 8), Math.max(0, height - 30), x + 4, y + 26) : [];
              return <g key={node.key}>
                <rect x={x + 1} y={y + 1} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} rx={3} fill={color(node)} className={node.entry ? 'chart-tile interactive' : 'chart-tile'} {...interaction(node)}><title>{label(node)}</title></rect>
                {width > 70 && height > 26 && <text x={x + 9} y={y + 18} className="chart-tile-label">{name(node).slice(0, Math.max(1, Math.floor((width - 18) / 14)))}</text>}
                {!children.length && width > 75 && height > 55 && <text x={x + 9} y={y + 40} className="chart-tile-size">{formatSize(node.value)}</text>}
                {children.map(child => <g key={child.node.key}>
                  <rect x={child.x + 1} y={child.y + 1} width={Math.max(0, child.width - 2)} height={Math.max(0, child.height - 2)} rx={2} fill={color(child.node)} className={child.node.entry ? 'chart-tile interactive nested' : 'chart-tile nested'} {...interaction(child.node)}><title>{label(child.node)}</title></rect>
                  {child.width > 75 && child.height > 26 && <text x={child.x + 7} y={child.y + 18} className="chart-tile-label">{name(child.node).slice(0, Math.max(1, Math.floor((child.width - 14) / 14)))}</text>}
                </g>)}
              </g>;
            })}
          </svg>
        </div>}
      </div>
      <div className="chart-insight">{selected ? <><i style={{ background: color(selected) }} /><span title={selected.entry?.path}>{name(selected)}<small>{selected.entry?.path || t('汇总项目，在文件树中查看完整明细。', 'Grouped items; view the full details in the file tree.')}</small></span><b>{formatSize(selected.value)}<small>{percent(selected.value)}</small></b></> : <span>{t('指向图形查看详情', 'Hover or focus for details.')}</span>}</div>
      <details className="chart-details" open><summary>{t('图表明细', 'Chart details')}<span>{t('最多 24 个项目，其余合并显示', 'Up to 24 items; the rest are grouped')}</span></summary>
        <table><caption className="sr-only">{t('当前目录图表数据，按当前统计口径计算', 'Chart data for this directory in the selected measure')}</caption><thead><tr><th>{t('名称', 'Name')}</th><th>{t('大小', 'Size')}</th><th>{t('占比', 'Share')}</th></tr></thead><tbody>
          {report.nodes.map(node => <tr key={node.key} data-chart-key={node.key}><th scope="row"><i style={{ background: color(node) }} />{node.entry ? <button disabled={disabled} title={node.entry.path} onClick={() => activate(node)}>{name(node)}{node.entry.kind === 'directory' && <ChevronRight size={13} />}</button> : <span>{name(node)} · {node.items.toLocaleString(locale)} {t('项', 'items')}</span>}
            {metric === 'allocated' && node.entry?.allocatedSize == null && node.entry && <small>{t('含未知占用，显示已知部分', 'Includes unknown sizes; showing known bytes')}</small>}
          </th><td>{formatSize(node.value)}</td><td>{percent(node.value)}</td></tr>)}
        </tbody></table>
      </details>
    </>}
    {!report && <div className="chart-empty" role={error ? 'alert' : 'status'}>{error ? <><Info size={28} /><p>{errorText(error, locale)}</p><button className="button secondary small" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></> : <><LoaderCircle size={26} className="spin" /><p>{t('正在读取图表数据…', 'Loading chart data…')}</p></>}</div>}
    <div className="chart-volume"><span>{t('所在磁盘', 'Containing volume')}</span>{summary.volume ? <span>{t('可用', 'Free')} <b>{formatSize(summary.volume.free)}</b> / {t('总容量', 'Total')} {formatSize(summary.volume.total)}</span> : <span>{t('容量暂不可用', 'Capacity unavailable')}</span>}</div>
  </section>;
}
