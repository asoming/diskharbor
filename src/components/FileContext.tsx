import { useEffect, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import type { DiskHarborAPI, Entry, FileContextReport } from '../types';
import { errorText } from '../errors';
import './file-context.css';

export function FileContext({ api, entry, scanId, locale }: {
  api: DiskHarborAPI; entry: Entry; scanId: string; locale: 'zh-CN' | 'en';
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const key = `${scanId}:${entry.id}:${entry.path}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; report?: FileContextReport; error?: unknown } | null>(null);
  const current = result?.key === key ? result : null;
  useEffect(() => {
    let active = true;
    setResult(null);
    void api.entryDetails(entry.id, scanId).then(report => {
      if (!active) return;
      if (report.scanId !== scanId || report.entryId !== entry.id || report.path !== entry.path) throw new Error('SCAN_CHANGED');
      setResult({ key, report });
    }).catch(error => { if (active) setResult({ key, error }); });
    return () => { active = false; };
  }, [api, key, entry.id, entry.path, scanId, attempt]);
  const report = current?.report;
  const cloudLabel = !report ? '' : {
    unknown: t('云端状态未知', 'Cloud status unknown'),
    suspected: t('可能位于同步目录', 'Possible sync location'),
    local: t('原生属性显示本地可用', 'Native attributes show local availability'),
    placeholder: t('云端占位或需下载', 'Cloud placeholder or download required'),
  }[report.cloud.status];
  return <section className="file-context" aria-label={t('归属与云端状态', 'Association and cloud status')}>
    <h4><Info size={14} aria-hidden="true" />{t('归属与状态', 'Association & status')}</h4>
    {!current && <p role="status">{t('正在读取元数据…', 'Reading metadata…')}</p>}
    {current?.error !== undefined && <div role="alert"><p>{errorText(current.error, locale)}</p>
      <button className="text-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={12} />{t('重试', 'Retry')}</button></div>}
    {report && <>
      <dl><dt>{t('可能关联的应用', 'Possible associated app')}</dt><dd>{report.association?.name || t('未识别', 'Not identified')}</dd>
        <dt>{t('云端状态', 'Cloud status')}</dt><dd>{cloudLabel}{report.cloud.provider && ` · ${report.cloud.provider}`}</dd>
        <dt>{t('扫描状态', 'Scan status')}</dt><dd>{{ ready: t('本次扫描已记录', 'Recorded by this scan'), pending: t('等待扫描', 'Pending'),
          partial: t('结果不完整', 'Incomplete'), skipped: t('已跳过', 'Skipped'), error: t('读取失败', 'Read failed') }[entry.state]}</dd></dl>
      <details><summary>{t('查看判断依据', 'How this was determined')}</summary>
        <div tabIndex={0} role="region" aria-label={t('归属与状态依据', 'Association and status evidence')}>
          {report.association ? <>
            <p>{t('与已知应用位置匹配，不代表已安装此应用，也不能证明文件由它创建。', 'The path matches a known app location. This does not prove installation or which application created the file.')}</p>
            <p>{report.association.role === 'cache' ? t('匹配缓存位置', 'Matched cache location') : t('匹配用户资料位置', 'Matched profile location')}：<span className="fc-path">{report.association.matchedRoot}</span></p>
            <p>{t('规则资料', 'Rule reference')}：<span className="fc-path">{report.association.source}</span></p>
          </> : <p>{t('没有匹配的归属规则，保留未知；文件类型和扩展名不会被当成应用归属证据。', 'No association rule matched. File type and extension do not establish ownership by an application.')}</p>}
          <p>{report.cloud.basis === 'native-metadata'
            ? t('云端判断来自本次原生元数据检查；“本地可用”不表示从未同步，状态之后仍可能变化。', 'Cloud status comes from this native metadata check. Local availability does not mean the item is never synced; its state can change later.')
            : t('尚未取得可确认云占位状态的原生属性。同步位置匹配只作保守提示，不会读取正文或下载文件来判断。', 'Native placeholder attributes have not been verified. A possible sync location is only a conservative hint; contents are not read or downloaded to determine this.')}</p>
          {report.cloud.matchedRoot && <p className="fc-path">{report.cloud.matchedRoot}</p>}
          {report.native?.volume && <p>{t('所在文件系统', 'Containing file system')}：{report.native.volume.filesystem || t('未知', 'Unknown')}<br /><span className="fc-path">{report.native.volume.mountPath}</span></p>}
          <p>{t('检查时间', 'Checked at')}：{new Date(report.checkedAt).toLocaleString(locale)}</p>
          <p>{t('以上信息不会授予清理权限；操作前仍会重新核对整个对象。', 'This information does not grant cleanup permission. The entire object is checked again before an operation.')}</p>
        </div>
      </details>
    </>}
  </section>;
}
