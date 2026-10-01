import { Info } from 'lucide-react';
import type { Summary } from '../types';
import './windows-permissions.css';

export function PlatformPermissions({ platform, summary, locale }: {
  platform: string; summary: Summary | null; locale: 'zh-CN' | 'en';
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const denied = summary?.errorDetails?.some(item => ['EACCES', 'EPERM', 'PERMISSION_DENIED'].includes(item.code));
  if (platform !== 'darwin' && !(platform === 'linux' && denied)) return null;
  const mac = platform === 'darwin';
  const title = mac ? t('macOS 文件访问', 'macOS file access') : t('Linux 文件访问', 'Linux file access');
  return <section className={`windows-permissions ${denied ? 'has-denied' : ''}`} aria-label={title}>
    <div className="wp-heading"><Info size={17} aria-hidden="true" /><div>
      <strong>{title}</strong>
      {denied && <span>{t('有位置访问被拒，扫描结果不完整。', 'Some locations denied access; scan results are incomplete.')}</span>}
    </div></div>
    <details><summary>{t('如何处理访问受限', 'Help with restricted access')}</summary><div className="wp-explanation">
      {mac ? <>
        <p>{t('如桌面、文稿或下载目录访问被拒，请在“系统设置 → 隐私与安全性 → 文件与文件夹”检查盘清的访问权限。', 'If Desktop, Documents or Downloads denies access, check DiskHarbor in System Settings → Privacy & Security → Files & Folders.')}</p>
        <p>{t('扫描受隐私保护的位置可能还需要“完全磁盘访问权限”。仅在你确实需要扫描这些位置时自行决定是否开启；盘清无法在这里确认这项系统授权的状态。', 'Scanning privacy-protected locations may also require Full Disk Access. Enable it only if you need those locations; DiskHarbor cannot confirm that system permission here.')}</p>
        <p>{t('更改授权后，按系统提示退出并重新打开盘清，再重新扫描。撤销授权后也要重扫；此前的扫描结果不会自动更新。', 'After changing access, quit and reopen DiskHarbor if macOS asks, then scan again. Rescan after revoking access too; earlier results do not update automatically.')}</p>
      </> : <p>{t('请查看具体受限路径，在文件管理器中检查当前用户的读取权限及磁盘是否仍挂载。需要更改权限时，请联系文件所有者或管理员；盘清不会自动修改权限。', 'Check the affected path, your read permissions in the file manager, and whether the drive is still mounted. Contact the owner or administrator if access must change; DiskHarbor does not change permissions automatically.')}</p>}
      <p>{t('访问拒绝也可能来自文件权限或系统策略。授权不保证全部文件可读，也不会解除清理保护；无法读取的内容不会按零占用计算。', 'File permissions or system policy can also deny access. Authorization does not guarantee every file is readable or remove cleanup protections; unread content is not counted as zero.')}</p>
      {summary?.state === 'scanning' && <p>{t('请先等待扫描结束或停止扫描，再重新扫描受影响范围。', 'Wait for this scan to finish or stop it before rescanning the affected scope.')}</p>}
    </div></details>
  </section>;
}
