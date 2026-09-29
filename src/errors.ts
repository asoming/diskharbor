export type Locale = 'zh-CN' | 'en';

const errors: Record<string, readonly [string, string]> = {
  NATIVE_POLICY_UNAVAILABLE: ['无法启用系统的云占位保护，扫描与文件操作暂不可用。请确认安装完整后重启应用。', 'System cloud placeholder protection could not be enabled. Scanning and file operations are unavailable. Check the installation and restart the app.'],
  NATIVE_METADATA_UNAVAILABLE: ['无法核对原生文件属性，暂不能读取内容或整理此项。请检查位置后重新扫描。', 'Native file attributes could not be verified. Content access and cleanup are unavailable for this item. Check the location and scan again.'],
  NATIVE_VOLUME_UNVERIFIED: ['无法确认此卷为受支持的本地文件系统，暂不能读取内容或整理此项。', 'This volume could not be verified as a supported local file system. Content access and cleanup are unavailable for this item.'],
  CLOUD_PLACEHOLDER: ['此项是云端占位文件或需要下载，盘清不会触发下载，也不会直接整理此项。', 'This item is a cloud placeholder or requires a download. DiskHarbor will not download or clean it.'],
  CLOUD_LOCATION_PROTECTED: ['此位置可能由云同步服务管理，不能在此直接整理。请在同步服务中确认文件状态后操作。', 'This location may be managed by a sync service and cannot be cleaned here. Check the file state in that service first.'],
  INVALID_PATH: ['路径无效，请检查后重试。', 'This path is invalid. Check it and try again.'],
  INVALID_PATHS: ['无法恢复这些浏览位置，请重新打开目录。', 'These browsing locations could not be restored. Open the folder again.'],
  INVALID_RETRY_TARGET: ['此项目不支持单独重扫，请重新扫描原文件夹。', 'This item cannot be retried on its own. Scan the original folder again.'],
  INVALID_CACHE_RULE: ['此缓存指引已不可用，请刷新识别结果。', 'This cache guide is unavailable. Refresh the findings.'],
  CACHE_REPORT_FAILED: ['无法读取缓存识别结果，请重试。', 'Cache findings could not be read. Try again.'],
  INVALID_SPACE_REQUEST: ['空间核验请求无效，请重新扫描后重试。', 'This space check request is invalid. Scan again and retry.'],
  SPACE_SCAN_NOT_READY: ['请等待扫描结束后再核验；扫描出错时请先重新扫描。', 'Wait for the scan to finish before checking space. If it failed, scan again first.'],
  SPACE_CHECK_IN_PROGRESS: ['上一次空间测量仍在进行，请等待当前读取结束。', 'A space measurement is still running. Wait for the current read to finish.'],
  SPACE_CHECK_TIMEOUT: ['空间测量超时，底层读取可能仍在继续，暂不能整理文件。可等待后重试，或重新扫描此位置。', 'The space check timed out, but the underlying read may still be running, so cleanup is temporarily unavailable. Wait and retry, or scan this location again.'],
  SPACE_ROOT_CHANGED: ['扫描根目录已变化或无法核对，不能比较空间。请检查设备连接和读取权限，再重新扫描。', 'The scan root changed or could not be verified, so space cannot be compared. Check the device connection and read permissions, then scan again.'],
  SPACE_UNAVAILABLE: ['未能取得有效的卷容量数据。本次变化未知，可检查设备连接后重试。', 'Valid volume capacity data could not be obtained. This change is unknown; check the device connection and retry.'],
  SPACE_CHECK_FAILED: ['空间测量结果无法核对，本次变化未知。请重新扫描后再试。', 'The space measurement could not be verified. This change is unknown. Scan again and retry.'],
  SCAN_BUSY: ['扫描尚未结束。请求停止后，请等待当前读取结束。', 'A scan is still active. After requesting a stop, wait for the current read to finish.'],
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
  ELEVATION_UNAVAILABLE: ['当前无法请求管理员权限。请使用已安装的 Windows 版本；也可关闭盘清后，通过快捷方式的“以管理员身份运行”重新打开。', 'Administrator authorization is unavailable. Use the installed Windows app; alternatively close DiskHarbor and reopen its shortcut with Run as administrator.'],
  ELEVATION_IN_PROGRESS: ['正在等待 Windows 授权，请先完成或取消系统提示。', 'Waiting for Windows authorization. Complete or cancel the system prompt first.'],
  ELEVATION_FAILED: ['无法以管理员身份重新打开，当前窗口已保留。请检查 Windows 的授权设置后重试。', 'Reopening as administrator failed. This window is kept. Check Windows authorization settings and try again.'],
  ELEVATION_READY_TIMEOUT: ['管理员窗口未能及时准备好，当前窗口和结果已保留。请稍后重试。', 'The administrator window did not become ready in time. This window and its results are kept. Try again later.'],
  ELEVATION_CHILD_EXITED: ['管理员窗口启动失败，当前窗口和结果已保留。', 'The administrator window could not start. This window and its results are kept.'],
  ELEVATION_RESTART_FAILED: ['管理员重启未能完成，请关闭未完成的窗口后重新打开盘清。', 'The administrator restart could not finish. Close the incomplete window and reopen DiskHarbor.'],
  SYSTEM_PATH: ['系统或受保护的位置不能在此回收。', 'System and protected locations cannot be trashed here.'],
  PROTECTED_ROOT: ['磁盘根目录、扫描根目录或个人目录不能整项回收。', 'A disk root, scan root, or home folder cannot be trashed as a whole.'],
  HIDDEN_PATH: ['隐藏项目或配置路径受到保护。', 'Hidden items or configuration paths are protected.'],
  INVALID_CLEANUP_OPTIONS: ['处理选项无效，请关闭清单后重新选择。', 'The cleanup options are invalid. Close the review and select the items again.'],
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
  PREVIEW_PLATFORM_UNVERIFIED: ['此系统缺少已支持的安全预览方式，文件内容未读取。', 'A supported safe preview method is unavailable on this system. File contents were not read.'],
  PREVIEW_VOLUME_UNVERIFIED: ['无法确认此位置为受支持的本地文件系统，因此不能显示预览。', 'This location could not be confirmed as a supported local file system. Its preview cannot be shown.'],
  PREVIEW_UNSUPPORTED_TYPE: ['暂不支持此文件类型。当前可预览 UTF-8 文本，以及 PNG、JPEG、WebP 图片。', 'This file type is not supported. Preview supports UTF-8 text and PNG, JPEG, or WebP images.'],
  PREVIEW_TOO_LARGE: ['此文件超过预览大小或图像尺寸上限。图片须在 8 MiB 内，单边不超过 8192 像素，总像素不超过 1600 万。', 'This file exceeds the preview size or image limits. Images must be within 8 MiB, 8192 pixels per side, and 16 million pixels in total.'],
  PREVIEW_INVALID_IMAGE: ['无法读取这张图片，格式可能不受支持或内容已损坏。', 'This image could not be read. Its format may be unsupported or its contents damaged.'],
  PREVIEW_BINARY_TEXT: ['此文件包含二进制内容，无法作为纯文本显示。', 'This file contains binary content and cannot be displayed as plain text.'],
  PREVIEW_ENCODING_UNSUPPORTED: ['此文本不是受支持的 UTF-8 编码，暂时无法预览。', 'This text is not in the supported UTF-8 encoding and cannot be previewed.'],
  PREVIEW_IN_PROGRESS: ['上一份内容仍在读取，请稍后重试。关闭预览窗口不会立即停止底层读取。', 'A previous preview is still being read. Try again shortly. Closing the preview does not immediately stop that read.'],
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
  ENODEV: ['设备已不可用，请重新连接并确认位置后再扫描。', 'The device is unavailable. Reconnect it and check the location before scanning again.'],
  ENXIO: ['无法访问此设备或位置，请检查设备连接。', 'This device or location cannot be accessed. Check its connection.'],
  ENOTCONN: ['此位置的连接已断开，请恢复连接后重试。', 'This location is disconnected. Restore the connection and try again.'],
  ETIMEDOUT: ['读取此位置超时，请检查连接后重试。', 'Reading this location timed out. Check its connection and try again.'],
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
  return locale === 'zh-CN' ? '无法完成此操作。请检查位置与权限，必要时重新扫描后再试。' : 'This operation could not be completed. Check the location and permissions, and scan again if needed.';
}

const previewErrors: Record<string, readonly [string, string]> = {
  SCAN_INCOMPLETE: ['此文件尚未完整扫描，请等待扫描完成或重新扫描后再预览。', 'This file has not been fully scanned. Wait for scanning to finish or scan again before previewing.'],
  SYSTEM_PATH: ['系统或受保护的位置不能在此预览。', 'Files in system or protected locations cannot be previewed here.'],
  HIDDEN_PATH: ['隐藏配置或数据受到保护，不能在此预览。', 'Hidden configuration or data is protected and cannot be previewed here.'],
  APPLICATION_DATA: ['应用数据受到保护，不能在此预览。', 'Application data is protected and cannot be previewed here.'],
  SYMLINK: ['链接不能在此预览，请选择实际的普通文件。', 'Links cannot be previewed here. Select a regular file.'],
  SYMLINK_PARENT: ['所在目录包含链接，不能在此预览。', 'The parent path contains a link and cannot be previewed here.'],
  NOT_REGULAR_FILE: ['仅可预览已完整扫描的普通文件。', 'Only fully scanned regular files can be previewed.'],
  SHARED_FILE: ['此文件与其他路径共享存储，暂不支持内容预览。', 'This file shares storage with other paths. Content preview is not supported for it.'],
  UNSUPPORTED_VOLUME: ['此位置暂不支持内容预览。', 'Content preview is not supported for this location.'],
  UNREADABLE_FILE: ['无法读取此文件的内容，请检查位置和访问权限。', 'This file could not be read. Check its location and access permissions.'],
};

export function previewErrorText(error: unknown, locale: Locale): string {
  const raw = rawError(error);
  const direct = aliases[raw] || raw;
  const code = previewErrors[direct] ? direct : raw.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.find(value => previewErrors[value]);
  return code ? previewErrors[code][locale === 'zh-CN' ? 0 : 1] : errorText(error, locale);
}
