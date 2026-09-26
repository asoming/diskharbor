export type Locale = 'zh-CN' | 'en';

const errors: Record<string, readonly [string, string]> = {
  INVALID_PATH: ['路径无效，请检查后重试。', 'This path is invalid. Check it and try again.'],
  INVALID_SELECTION: ['选择无效或项目过多，请重新选择。', 'The selection is invalid or too large. Select items again.'],
  INVALID_ENTRY_ID: ['此项目无法识别，请重新扫描。', 'This item cannot be identified. Scan again.'],
  INVALID_QUERY: ['查询无效，请调整筛选后重试。', 'The query is invalid. Adjust the filters and try again.'],
  INVALID_SEARCH: ['搜索内容过长或无效，请缩短后重试。', 'The search is too long or invalid. Shorten it and try again.'],
  INVALID_CATEGORY: ['此分类无效，请清除分类筛选。', 'This category is invalid. Clear the category filter.'],
  INVALID_SIZE: ['大小筛选无效，请重新选择。', 'The size filter is invalid. Select it again.'],
  INVALID_KIND: ['此项目类型不受支持。', 'This item type is not supported.'],
  INVALID_PLAN: ['处理清单无效，请重新预览。', 'The cleanup plan is invalid. Review the selection again.'],
  PLAN_USED_OR_MISSING: ['此清单已使用或不存在，请重新预览。', 'This plan was already used or is unavailable. Review the selection again.'],
  PLAN_EXPIRED: ['清单已过期，请重新预览。', 'The plan expired. Review the selection again.'],
  NO_ELIGIBLE_FILES: ['没有符合条件的项目，未执行回收。', 'No items are eligible. Nothing was sent to Trash.'],
  NO_ELIGIBLE_ITEMS: ['没有符合条件的项目，未执行回收。', 'No items are eligible. Nothing was sent to Trash.'],
  NO_SCAN: ['尚无可用扫描，请先扫描文件夹。', 'There is no available scan. Scan a folder first.'],
  SCAN_CHANGED: ['扫描已更换，请重新预览。', 'The scan changed. Review the selection again.'],
  SCAN_REPLACED: ['上次扫描已被新的扫描替代。', 'The previous scan was replaced by a new scan.'],
  SCAN_IN_PROGRESS: ['请等待扫描结束后再整理。', 'Wait for the scan to finish before cleanup.'],
  SCAN_INCOMPLETE: ['此项目尚未完整扫描，不能执行回收。', 'This item has not been fully scanned and cannot be trashed.'],
  SCAN_ERROR: ['扫描失败，请检查位置和权限后重试。', 'The scan failed. Check the location and permissions, then try again.'],
  SCAN_QUERY_TIMEOUT: ['读取扫描结果超时，请稍后重试。', 'Reading the scan results timed out. Try again shortly.'],
  SCAN_START_TIMEOUT: ['扫描启动超时，请检查目标是否可访问。', 'Starting the scan timed out. Check that the location is accessible.'],
  SCAN_WORKER_FAILED: ['扫描进程已停止，结果可能不完整。', 'The scanning process stopped. Results may be incomplete.'],
  NOT_A_DIRECTORY: ['请选择文件夹或磁盘路径。', 'Choose a folder or disk path.'],
  NOT_IN_SCAN: ['此项目不在当前扫描中，请重新扫描。', 'This item is not in the current scan. Scan again.'],
  ENTRY_UNAVAILABLE: ['此项目已不可用，请重新扫描。', 'This item is no longer available. Scan again.'],
  UNSUPPORTED_VOLUME: ['此位置暂不支持安全回收。', 'Trash is not supported for this location.'],
  UNSUPPORTED_PATH: ['暂不支持此路径编码。', 'This path encoding is not supported.'],
  UNREADABLE_FILE: ['无法读取此项目的信息。', 'The item metadata cannot be read.'],
  MISSING_FILE: ['此项目已不存在，请重新扫描。', 'This item no longer exists. Scan again.'],
  PERMISSION_DENIED: ['没有访问或处理此项目的权限。', 'Permission to access or process this item was denied.'],
  SYSTEM_PATH: ['系统或受保护的位置不能在此回收。', 'System and protected locations cannot be trashed here.'],
  PROTECTED_ROOT: ['磁盘根目录、扫描根目录或个人目录不能整项回收。', 'A disk root, scan root, or home folder cannot be trashed as a whole.'],
  HIDDEN_PATH: ['隐藏配置或数据受到保护。', 'Hidden configuration or data is protected.'],
  APPLICATION_DATA: ['应用数据目录受到保护。', 'Application data folders are protected.'],
  SYMLINK: ['链接不能在此回收。', 'Links cannot be trashed here.'],
  SYMLINK_PARENT: ['所在目录包含链接，不能在此回收。', 'The parent path contains a link and cannot be trashed here.'],
  NOT_REGULAR_FILE: ['此项目不是可处理的普通文件或文件夹。', 'This is not an eligible regular file or folder.'],
  IDENTITY_CHANGED: ['此项目已变化，请重新扫描。', 'This item changed. Scan again.'],
  PARENT_CHANGED: ['所在目录已变化，请重新扫描。', 'The parent folder changed. Scan again.'],
  SHARED_FILE: ['此文件与其他路径共享存储，暂不支持回收。', 'This file shares storage with other paths and cannot be trashed here.'],
  DIRECTORY_TOO_LARGE: ['文件夹超过当前检查上限，请选择更小的子文件夹。', 'This folder exceeds the current inspection limit. Select a smaller subfolder.'],
  DIRECTORY_CHANGED: ['文件夹内容或身份已变化，请重新扫描。', 'The folder contents or identity changed. Scan again.'],
  UNSAFE_DESCENDANT: ['文件夹包含无法处理的项目，因此整个文件夹不会回收。', 'This folder contains a blocked item, so the entire folder will be left in place.'],
  MANIFEST_UNAVAILABLE: ['无法取得文件夹内容清单，请重新扫描。', 'The folder contents could not be verified. Scan again.'],
  MANIFEST_INCOMPLETE: ['文件夹内容清单不完整，不能执行回收。', 'The folder contents were not fully verified and cannot be trashed.'],
  CLEANUP_IN_PROGRESS: ['正在处理另一份清单，请等待其结束。', 'Another cleanup is in progress. Wait for it to finish.'],
  OPERATION_CANCELLED: ['已取消此项，未开始处理。', 'This item was cancelled before processing started.'],
  APP_INTERRUPTED: ['应用退出导致操作中断，此项未开始处理。', 'The application stopped. This item had not started processing.'],
  RESULT_UNCERTAIN: ['操作中断，无法确认此项是否已回收。请检查原位置和系统回收站。', 'The operation was interrupted and this result is uncertain. Check both the original location and the system Trash.'],
  TRASH_FAILED: ['系统未能回收此项；不会改为永久删除。', 'The system could not trash this item. It will not be permanently deleted instead.'],
  TRASH_OPEN_FAILED: ['无法打开系统回收站，请从系统文件管理器进入。', 'The system Trash could not be opened. Open it from your file manager.'],
  HISTORY_CORRUPT: ['操作记录已损坏，无法完整读取。记录尚未被清除；可明确选择重置记录。', 'The activity log is damaged and cannot be fully read. It has not been cleared; you can explicitly reset it.'],
  HISTORY_TOO_LARGE: ['操作记录超出当前读取上限，记录尚未被清除。', 'The activity log exceeds the current reading limit. It has not been cleared.'],
  HISTORY_READ_FAILED: ['无法读取本地操作记录，记录尚未被清除。', 'The local activity log could not be read. It has not been cleared.'],
  HISTORY_WRITE_FAILED: ['操作记录保存失败，请核查已显示结果和系统回收站。未显示的结果不能视为成功。', 'Saving the activity log failed. Check the displayed results and the system Trash. Unreported outcomes must not be treated as successful.'],
  INVALID_HISTORY: ['操作记录格式无效，记录尚未被清除。', 'The activity log format is invalid. It has not been cleared.'],
  INVALID_HISTORY_ITEM: ['此操作结果无法保存为有效记录。', 'This result could not be saved as a valid activity record.'],
  ENOENT: ['此位置已不存在或无法找到。', 'This location no longer exists or cannot be found.'],
  EACCES: ['没有访问此位置的权限。', 'Permission to access this location was denied.'],
  EPERM: ['系统不允许此操作。', 'The system did not allow this operation.'],
  EROFS: ['此位置为只读，无法修改。', 'This location is read-only and cannot be changed.'],
  ENOSPC: ['系统报告空间不足，操作未能完成。', 'The system reported insufficient space. The operation could not finish.'],
  EBUSY: ['此项目正在使用，请稍后重试。', 'This item is in use. Try again later.'],
  ESTALE: ['扫描时此位置发生变化，请重新扫描。', 'This location changed during the scan. Scan again.'],
  EIO: ['读取设备时发生错误，请检查设备连接。', 'A device read failed. Check the device connection.'],
  UNTRUSTED_SENDER: ['此操作请求未被应用接受，请重新打开应用。', 'The application did not accept this request. Reopen the application.'],
};

const aliases: Record<string, string> = {
  not_file: 'NOT_REGULAR_FILE', symlink: 'SYMLINK', protected: 'SYSTEM_PATH', hidden: 'HIDDEN_PATH',
  changed: 'IDENTITY_CHANGED', missing: 'MISSING_FILE', shared: 'SHARED_FILE',
};

export function rawError(error: unknown): string {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '').trim();
}

export function errorText(error: unknown, locale: Locale): string {
  const raw = rawError(error);
  const direct = aliases[raw] || raw;
  const code = errors[direct] ? direct : raw.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.find(value => errors[value]);
  if (code) return errors[code][locale === 'zh-CN' ? 0 : 1];
  const fallback = locale === 'zh-CN' ? '无法完成此操作。' : 'This operation could not be completed.';
  return raw ? `${fallback} ${raw}` : fallback;
}
