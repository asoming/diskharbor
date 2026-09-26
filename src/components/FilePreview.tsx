import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Eye, FileText, Image, Info, LoaderCircle, X } from 'lucide-react';
import type { Entry, FilePreviewResult } from '../types';
import { previewErrorText, type Locale } from '../errors';
import './file-preview.css';

type FilePreviewProps = {
  entry: Entry;
  locale: Locale;
  result: FilePreviewResult | null;
  loading: boolean;
  error: string;
  onClose(): void;
  returnFocusTo: HTMLElement | null;
};

// This component never reads a file. App supplies only the result of an
// explicit Preview content action, and discards results from stale requests.
export function FilePreview({ entry, locale, result, loading, error, onClose, returnFocusTo }: FilePreviewProps) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const imageAllowed = result?.kind === 'image'
    && ['image/png', 'image/jpeg', 'image/webp'].includes(result.mime)
    && result.dataUrl.startsWith(`data:${result.mime};base64,`);
  const displayError = error || (result?.kind === 'image' && (!imageAllowed || imageFailed) ? 'PREVIEW_INVALID_IMAGE' : '');

  useEffect(() => { setImageFailed(false); }, [result]);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      // Wait for App to remove inert from the underlying page before restoring
      // focus. Closing this view does not claim to cancel the native read.
      requestAnimationFrame(() => {
        if (returnFocusTo?.isConnected && !returnFocusTo.closest('[inert]')) returnFocusTo.focus({ preventScroll: true });
      });
    };
  }, [entry.id, returnFocusTo]);

  return (
    <div className="fp-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="fp-dialog" ref={dialog} role="dialog" aria-modal="true"
        aria-labelledby="file-preview-heading file-preview-title" aria-describedby="file-preview-path"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
            event.preventDefault(); first.focus();
          }
        }}>
        <header className="fp-header">
          <span className="fp-type-icon" aria-hidden="true">{result?.kind === 'image' ? <Image size={23} /> : result?.kind === 'text' ? <FileText size={23} /> : <Eye size={23} />}</span>
          <div className="fp-heading">
            <p id="file-preview-heading">{t('内容预览', 'Content preview')}</p>
            <h2 id="file-preview-title">{entry.name}</h2>
          </div>
          <button className="icon-btn fp-close" ref={closeButton} onClick={onClose} aria-label={t('关闭内容预览', 'Close content preview')}><X size={21} /></button>
        </header>
        <p className="fp-path" id="file-preview-path" title={entry.path}>{entry.path}</p>
        <div className="fp-body" aria-busy={loading}>
          {loading ? (
            <div className="fp-message" role="status"><LoaderCircle size={28} className="spin" aria-hidden="true" /><h3>{t('正在读取内容…', 'Reading content…')}</h3><p>{t('正在读取你选择的文件。', 'Reading the file you selected.')}</p></div>
          ) : displayError ? (
            <div className="fp-message fp-error" role="alert"><AlertCircle size={28} aria-hidden="true" /><h3>{t('暂时无法预览', 'Preview unavailable')}</h3><p>{previewErrorText(displayError, locale)}</p></div>
          ) : result?.kind === 'text' ? (
            <>
              <div className="fp-content-meta"><span><FileText size={14} />{t('纯文本 · UTF-8', 'Plain text · UTF-8')}</span><span>{t(`已读取 ${result.bytesRead.toLocaleString(locale)} 字节`, `${result.bytesRead.toLocaleString(locale)} bytes read`)}</span></div>
              {result.truncated && <div className="fp-truncated" role="status"><Info size={16} /><span>{t('仅显示文件开头的部分内容，最多 64 KiB。后面的内容未加载。', 'Only the beginning of this file is shown, up to 64 KiB. The remaining content has not been loaded.')}</span></div>}
              {result.text.length ? <pre className="fp-text" tabIndex={0} role="region" aria-label={t('文件纯文本内容', 'Plain text file content')}>{result.text}</pre>
                : <div className="fp-message"><FileText size={28} aria-hidden="true" /><h3>{t('这是一个空文本文件', 'This text file is empty')}</h3><p>{t('没有可显示的正文。', 'There is no text to display.')}</p></div>}
            </>
          ) : result?.kind === 'image' && imageAllowed ? (
            <>
              <div className="fp-content-meta"><span><Image size={14} />{result.mime.replace('image/', '').toUpperCase()} · {result.width.toLocaleString(locale)} × {result.height.toLocaleString(locale)} {t('像素', 'pixels')}</span><span>{t(`已读取 ${result.bytesRead.toLocaleString(locale)} 字节`, `${result.bytesRead.toLocaleString(locale)} bytes read`)}</span></div>
              <div className="fp-image-stage" tabIndex={0} role="region" aria-label={t('图片内容', 'Image content')}>
                <img className="fp-image" src={result.dataUrl} alt={t(`${entry.name} 的内容预览`, `Content preview of ${entry.name}`)} onError={() => setImageFailed(true)} draggable={false} />
              </div>
            </>
          ) : null}
        </div>
        <footer className="fp-footer"><span><Eye size={14} />{t('仅查看内容，不修改文件', 'View contents without changing the file')}</span><button className="button secondary small" onClick={onClose}>{t('关闭预览', 'Close preview')}</button></footer>
      </section>
    </div>
  );
}
