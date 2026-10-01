import { ShieldCheck } from 'lucide-react';
import type { Summary } from '../types';
import './windows-permissions.css';

export function PlatformPermissions({ platform, summary, locale, locked, onOpen }: {
  platform: string; summary: Summary | null; locale: 'zh-CN' | 'en'; locked: boolean;
  onOpen(panel: 'files' | 'disk'): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const denied = summary?.errorDetails?.some(item => ['EACCES', 'EPERM', 'PERMISSION_DENIED'].includes(item.code));
  if (platform !== 'darwin' && !(platform === 'linux' && denied)) return null;
  const mac = platform === 'darwin';
  return <section className={`windows-permissions ${denied ? 'has-denied' : ''}`} aria-label={mac ? t('macOS 文件访问', 'macOS file access') : t('Linux 文件访问', 'Linux file access')}>
    <details className="permission-control"><summary><ShieldCheck size={16} aria-hidden="true" />{t('访问权限', 'Access')}{denied && <i className="permission-dot" />}</summary>
      <div className="permission-popover"><strong>{t('文件访问', 'File access')}</strong>
        {denied && <p>{t('部分位置无法读取。', 'Some locations could not be read.')}</p>}
        {mac ? <>
          <button className="button secondary small" disabled={locked} onClick={() => onOpen('disk')}>{t('完全磁盘访问', 'Full Disk Access')}</button>
          <button className="text-button" disabled={locked} onClick={() => onOpen('files')}>{t('文件与文件夹权限', 'Files & Folders access')}</button>
          <p>{t('在系统设置中开启 DiskHarbor，按提示重启后重扫。', 'Enable DiskHarbor in System Settings, restart if requested, then rescan.')}</p>
        </> : <p>{t('检查文件读取权限与磁盘挂载状态。', 'Check file read permissions and whether the drive is mounted.')}</p>}
      </div>
    </details>
  </section>;
}
