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
    <details className="permission-control"><summary><ShieldCheck size={16} aria-hidden="true" />
      {elevated === true ? t('管理员', 'Administrator') : t('访问权限', 'Access')}{denied && <i className="permission-dot" />}
    </summary><div className="permission-popover">
      <strong>{elevated === true ? t('管理员权限', 'Administrator access') : elevated === false ? t('标准用户权限', 'Standard user access') : t('无法确认当前权限', 'Current access level unavailable')}</strong>
      {denied && <p>{t('部分位置无法读取。', 'Some locations denied access; scan results are incomplete.')}</p>}
      {state?.canRequestElevation && <button className="button secondary small" disabled={locked || pending || summary?.state === 'scanning'} onClick={onRequest}>
        {pending ? t('等待授权…', 'Waiting for authorization…') : t('以管理员身份重新打开', 'Reopen as administrator')}
      </button>}
      <p>{elevated === true
        ? t('已经使用管理员权限，部分文件仍可能导致读取失败。', 'Administrator access is active; some files may still be unreadable.')
        : t('Windows 会请求授权。取消保留当前结果；重新打开后重扫。', 'Windows will request authorization. Cancelling keeps this window and its results. Rescan after reopening.')}</p>
      <p>{t('隐藏文件需在显示选项中开启；回收时另行确认。', 'Hidden files are separate from access permissions; enable them in display options and review before cleanup.')}</p>
    </div></details>
  </section>;
}
