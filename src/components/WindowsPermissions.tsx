import { ShieldCheck } from 'lucide-react';
import type { Summary, WindowsPermissionState } from '../types';
import './windows-permissions.css';

export function WindowsPermissions({ state, summary, locale, locked, pending, onRequest }: {
  state?: WindowsPermissionState; summary: Summary | null; locale: 'zh-CN' | 'en';
  locked: boolean; pending: boolean; onRequest(): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const denied = summary?.errorDetails?.some(item => ['EACCES', 'EPERM', 'PERMISSION_DENIED'].includes(item.code));
  const elevated = state?.elevated;
  return <section className={`windows-permissions ${denied ? 'has-denied' : ''}`} aria-label={t('Windows 访问权限', 'Windows access permissions')}>
    <div className="wp-heading"><ShieldCheck size={17} aria-hidden="true" /><div>
      <strong>{elevated === true ? t('管理员权限', 'Administrator access') : elevated === false ? t('标准用户权限', 'Standard user access') : t('无法确认当前权限', 'Current access level unavailable')}</strong>
      {denied && <span>{t('有位置访问被拒，扫描结果不完整。', 'Some locations denied access; scan results are incomplete.')}</span>}
    </div>
      {state?.canRequestElevation && <button className="button secondary small" disabled={locked || pending || summary?.state === 'scanning'} onClick={onRequest}>
        {pending ? t('等待 Windows 授权…', 'Waiting for Windows authorization…') : t('以管理员身份重新打开', 'Reopen as administrator')}
      </button>}
    </div>
    <details><summary>{t('权限与隐藏文件说明', 'About permissions and hidden files')}</summary><div className="wp-explanation">
      <p>{elevated === true
        ? t('已经使用管理员权限。文件占用、加密、系统策略等仍可能导致读取失败，请查看下方具体问题。', 'Administrator access is active. File locks, encryption and system policies can still prevent reads; check the specific errors below.')
        : t('点击重新打开后，Windows 会按系统设置请求同意或管理员凭据。取消授权会保留当前窗口与结果；重新打开成功后需要重新选择位置扫描。', 'Windows will request consent or administrator credentials according to system settings. Cancelling keeps this window and its results; after reopening, select a location and scan again.')}</p>
      <p>{t('扫描时不自动授权，也不修改文件权限。管理员模式可能看到更多文件，但不保证能读取所有文件；映射的网络盘可能不可见。', 'Scanning never elevates automatically or changes file permissions. Administrator mode may read more files, but not every file; mapped network drives may be unavailable.')}</p>
      <p>{t('隐藏文件不等于没有访问权限。要回收普通隐藏项目，请在处理清单中明确勾选本次允许；系统、应用数据和配置目录仍受保护。', 'Hidden files are separate from access permissions. To trash ordinary hidden items, explicitly allow them in that cleanup review; system, app-data and configuration paths stay protected.')}</p>
      {summary?.state === 'scanning' && <p>{t('请等待扫描完成，或停止扫描后再重新打开。', 'Wait for the scan to finish, or stop it before reopening.')}</p>}
    </div></details>
  </section>;
}
