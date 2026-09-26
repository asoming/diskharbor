import { Eye, EyeOff } from 'lucide-react';
import type { Summary, ViewVisibility } from '../types';
import './view-filters.css';

export function ViewFilters({ locale, value, summary, disabled, onChange }: {
  locale: 'zh-CN' | 'en'; value: ViewVisibility; summary: Summary;
  disabled: boolean; onChange(value: ViewVisibility): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const all = value.includeHidden && value.includeSystem;
  const Icon = all ? Eye : EyeOff;
  return <section className="view-filters" aria-label={t('列表显示', 'List display')}>
    <div className="view-filters-row">
      <h3><Icon size={16} aria-hidden="true" />{t('列表显示', 'List display')}</h3>
      <label><input type="checkbox" checked={value.includeHidden} disabled={disabled}
        onChange={event => onChange({ ...value, includeHidden: event.target.checked })} />{t('显示隐藏项', 'Show hidden items')}</label>
      <label><input type="checkbox" checked={value.includeSystem} disabled={disabled}
        onChange={event => onChange({ ...value, includeSystem: event.target.checked })} />{t('显示系统与应用数据', 'Show system and app data')}</label>
      {!all && <button className="text-button" disabled={disabled}
        onClick={() => onChange({ includeHidden: true, includeSystem: true })}>{t('显示全部', 'Show all items')}</button>}
    </div>
    <div className="view-filters-note">
      <p>{t('目录大小与分类统计包含未显示的内容。', 'Folder sizes and category totals include items hidden from the lists.')}</p>
      {summary.visibility?.rootIsSystem && <p className="view-filters-root-note">{t('已明确选择系统或应用数据位置。', 'A system or app-data location was explicitly selected.')}</p>}
      <details className="view-filters-details"><summary>{t('显示规则', 'Display rules')}</summary>
        <div tabIndex={0} role="region" aria-label={t('显示规则说明', 'Display rule details')}>
          <p>{t('隐藏项按扫描根以下的点号名称及其后代识别；系统与应用数据按已知位置识别。项目同时符合两类时，需开启两个开关才显示。', 'Hidden items are identified by dot-prefixed names below the scan root and their descendants. System and app data use known locations. Items matching both rules need both options enabled.')}</p>
          <p>{t('这是路径识别，尚未读取 Windows 隐藏属性或 macOS Finder 隐藏标记。明确选择的扫描根始终可见；根本身位于系统或应用数据位置时，会展示其内容，根下新的点号项仍由隐藏开关控制。', 'These are path rules; Windows hidden attributes and macOS Finder hidden flags are not read. The chosen scan root stays visible. Choosing a system or app-data root shows its contents; new dot-prefixed items below it still follow the hidden-item option.')}</p>
          <p>{t('开关只改变概览候选、文件树和搜索列表；不会少扫描或改变卷容量。切换时会清除勾选与详情；选中一个目录仍表示整个目录，清理保护不会放宽。', 'The options only change overview candidates, the tree and search lists. They do not reduce scanning or change volume capacity. Changing an option clears selection and details. Selecting a folder still means the entire folder, with the same cleanup protections.')}</p>
          <p>{t('同根重扫和页面切换保留设置；更换扫描根或重启后恢复默认。', 'Options persist across pages and rescans of the same root. A different scan root or restart resets them.')}</p>
        </div>
      </details>
    </div>
  </section>;
}
