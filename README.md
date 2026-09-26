# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor is a local desktop disk space analyzer. Explore what occupies your storage, inspect files and folders, and review selected items before moving them to the system Trash.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

**0.1.0-alpha.10 — an early desktop alpha.** This iteration adds shared display options for hidden items and system/application data, both off by default. They filter lists while preserving scan coverage, totals and cleanup protection. Browsing memory follows same-root scans, hidden locations fall back to a visible parent, and explicit cache navigation enables the display options it needs. The production build, local regression checks, three-platform CI jobs and Linux package/launcher validation have completed. The separate Linux CLI restoration report retains its known limitation. The application does not restore files automatically or empty the Trash. The Linux CLI Chinese-name restoration limitation remains, browser-cache support is guidance-only, and Windows/macOS content preview remains disabled. Renderer sandboxing remains enabled. Clean-machine installation, signed Windows/macOS packages and complete platform compatibility remain pending.

The first stable release targets the same core workflows on Linux, Windows, and macOS. These alpha checks cover the tested workflows, not complete platform support.

## Available functionality

- **Scan scope details:** expand the selected root, local start time, elapsed time, a scan-start volume-capacity snapshot, available device/mount information and skip categories. Unknown values remain explicit. Details start collapsed and reset when the scan changes.
- **Storage overview:** real scan results grouped by category, with allocated space and logical file size shown separately.
- **File explorer:** an expandable file tree with lazy loading, pagination, virtualized rows, keyboard navigation, sorting, search, and size/category filters.
- **List display options:** shared **Show hidden items** and **Show system and app data** options for overview candidates, the tree and file lists, plus **Show all items**. Excluded-item counts describe the current query; folder sizes and totals still include those contents.
- **Session navigation memory:** return to a browsing scope with its filters, sorting, expanded folders and scroll position. A completed rescan of the same root restores remembered locations by exact path, using the new scan's IDs.
- **Scan cancellation:** request a stop while keeping discovered results available. A pending filesystem call must return before the scan is reported as cancelled; a visible waiting state follows page navigation, and a new scan cannot begin while the old one remains active.
- **Read-error review:** inspect up to 100 recorded failures with paths and explanations. Explicitly rescan a failed directory, or the containing directory when a file failed. The new scan replaces the current scope and totals; results are not merged. An action lets you rescan the original scope again.
- **File details:** inspect metadata and paths, reveal an item in the system file manager, and copy its path.
- **On-demand content preview:** explicitly preview supported UTF-8 text and PNG, JPEG, or WebP images on verified local Linux filesystems. Inspecting an item does not automatically read its contents.
- **Browser-cache guidance:** identify selected standard Chrome, Chromium and Firefox cache layouts from already-scanned metadata, inspect recorded usage and the matching basis, copy a fixed browser settings address, and follow manual cache-only cleanup steps.
- **Reviewed file and folder cleanup:** select ordinary files or eligible directories, inspect the plan, and confirm through a native dialog. A directory is moved as one native Trash item only after its complete indexed contents pass metadata checks and match the current filesystem. A blocked directory is not partially cleaned, and a failed Trash operation never falls back to permanent deletion.
- **Cleanup progress and cancellation:** see individual operation results and stop operations that have not started. An in-flight native Trash call may finish; cancellation does not undo completed moves.
- **System Trash access and guidance:** open the system Trash and expand five bilingual restoration steps covering item identification, system actions, name conflicts, missing folders and checking the restored result. The guide is keyboard-scrollable at the minimum window size. DiskHarbor does not restore files automatically or empty the Trash; restoration depends on the item still being available and the system’s capabilities.
- **Durable local history:** save checkpoints before native operations and after individual results, retaining up to 50 operation records. Interrupted work is not automatically resumed; pending items become cancelled and items last recorded as processing become uncertain results. File absence is never treated as proof of a successful move.
- **Operation space measurements:** new cleanup records show before/after times, volume capacity and available space, with a signed change only when the samples can be compared. Result cards and activity history share expandable measurement details; legacy records are clearly marked as unverified.
- **Space verification:** manually compare the containing volume’s available space at scan start and at a new check. See both times, capacity values and a signed change; unavailable comparisons stay unknown. Results follow the current scan across pages and languages, without updating the file list or writing an activity record.
- **Local, bilingual use:** Chinese and English interfaces without an account or uploading scanned filenames, paths, or file contents.
- **Linux application launcher:** the desktop entry supports the Chinese name **盘清** as well as **DiskHarbor**.

## Scanning and retry boundaries

- Only the selected root is scanned; symbolic links are not followed. Detected volume or mount boundaries are skipped and require a separate scan. Linux mount information includes bind mounts; device-only detection can miss boundaries on the same device. Windows/macOS mount locations and filesystem names currently remain unknown. Regular hidden files remain in scope, while cleanup protection is checked separately.
- Volume capacity and free space describe the containing volume at scan start, not the selected folder’s capacity or live free space. The device ID is for this scan, not a permanent disk serial number. Skip counts describe discovered entries, not all excluded descendants or their bytes; unknown-allocation counts cover indexed file/link entries, not unread descendants. Unknown allocation is not treated as zero.
- Before a scan completes, the root’s type, device and file identity are rechecked. Detected disappearance or replacement preserves partial results and reports failure. Scanning is not a transaction snapshot; files or devices can change during it, and a finished scan does not guarantee whole-disk coverage.
- Cancellation stops scheduling new scan work. It cannot forcibly interrupt every operating-system read, so a blocked read may leave the application in the waiting state until that call returns. You can continue browsing discovered results; they are marked incomplete when cancellation finishes.
- Error details are capped at **100 entries** even when the total failure count is higher. Retrying is a user action after the active scan ends. It does not grant elevated permissions or alter filesystem permissions.
- A retry starts a separate scan of the eligible failed directory or a failed file's parent directory within the previous scan root. The previous totals are replaced rather than combined with the new results. Unsupported filenames cannot become retry paths.
- File-tree and file-list navigation memory lives only in the current application session. It includes search, minimum logical size, sorting, visible columns, browsing scope, expanded folders, loaded pages and scroll position. Same-root rescan restoration waits for the replacement scan to complete; a location absent from the new results falls back to its nearest remembered ancestor available in that scan. Absence from scan results does not prove that a folder was deleted. Changing the scan root or restarting clears this memory. A remembered keyboard row is restored only when its exact path is among the loaded rows; cleanup checkboxes and file details are not automatically restored.
- Navigation memory keeps at most **16 views**, with **16 expanded folders per view**. Automatic restoration is capped at **500 rows per folder** and **2,000 rows in total**; the interface explains the limit and lets you continue loading manually. Restoration remains pending until the replacement scan completes, including when it is cancelled.

## List-display boundaries

- Both options start off and filter overview candidates, the tree and file lists without narrowing the scan. Hidden items still contribute to totals, folder sizes and proportions. Excluded-item counts describe the current query, not the whole volume: direct children in a directory view, or matching entries in a flat/search view. Each entry is counted once.
- Hidden-item detection uses dot-prefixed paths below the selected scan root; system/application-data detection uses known locations. These are not Windows hidden attributes or macOS Finder hidden flags. An item matching both rules needs both options enabled. The selected root stays visible. Explicitly scanning a system/application-data location does not hide its entire contents when that option is off; dot-prefixed descendants still follow the hidden-item option.
- Same-root rescans and page changes retain the options; a different root or restart resets them. Browsing locations, expanded folders, loaded pages and scrolling are remembered separately for each display mode. Hiding the current folder falls back to a visible parent with an explanation. Switching clears selection and details, and stale requests cannot restore hidden rows. Explicit cache-to-tree navigation enables the options needed to show that location.
- Display settings do not change cleanup eligibility. Selecting an ordinary parent still validates all descendants, including hidden contents; protected or unsafe descendants block the entire directory operation. Showing caches, hidden items or system data does not authorize deletion.

## Space-verification boundaries

- Choose **Check available space** after a scan finishes or is cancelled. The baseline is captured during scanning; subsequent checks require an explicit action. The check is bound to that scan and its selected root; it does not accept a separate path. It reads volume metadata without scanning file contents or deleting files.
- Both the starting record and each new measurement check the root’s directory identity and resolved path before and after reading volume metadata. A changed or unavailable root is rejected. Missing starting data or changes in volume characteristics or total capacity make the difference unknown, with an explicit rescan action. These checks are not an atomic filesystem snapshot and cannot eliminate every path race.
- The difference is **current available space minus available space at scan start**, preserving positive, negative and zero values. It describes the entire containing volume, not the selected folder or space guaranteed to have been freed by DiskHarbor. Same-volume Trash moves usually do not immediately free space; other applications, snapshots and delayed system operations can also affect the observation.
- Results remain only in the current application session for that scan. A new check clears the old result before reading; failure does not leave an old success displayed. Changing scans clears the result and discards late replies. Page and language changes retain the same result. Checking does not refresh the file list, create an activity record, clear caches or start a scan; use **Scan again** explicitly when needed.
- Checks are refused while scanning or cleanup is active. A response timeout does not cancel the underlying filesystem read: further checks and cleanup remain blocked until that read settles or the user explicitly replaces the scan. Replacing the scan discards its old context without guaranteeing that the old system call has stopped. The application does not observe or confirm a browser’s native cleanup outcome.
- New cleanup records use a separate **before/after-operation** interval with the same root-identity and resolved-path checks around each volume reading. The result and activity history show both times, available space and total capacity. A numeric change is recorded only for comparable samples; missing readings, an unverifiable root or changed volume characteristics remain incomparable. These observations are not a guarantee of space freed and differ from the manual scan-start comparison.
- Measurement details distinguish an operation that did not start, a pending final reading and an interrupted measurement. On restart, unfinished records retain any valid starting sample but clear the final sample and difference. Legacy records keep their original difference with **“Legacy record; volume identity not verified”**; they are not upgraded to verified measurements.

## Browser-cache boundaries

- Rules cover selected standard layouts on Linux, Windows and macOS, anchored to trusted user/cache locations. Chromium-family matches require a supported profile’s `Cache/Cache_Data` structure; Firefox matches require `cache2` with `entries` and `index`. A folder merely named “Cache” is not enough. Custom paths, sandboxed installations and unsupported layouts may not appear; no matches does not mean there is no cache.
- Matching queries the current scan index without reading cache contents or searching outside the scanned scope. Reports are tied to the scan ID, show at most **50 locations**, and distinguish partial results. Allocated space, logical size and file count remain separate; unknown allocation stays unknown. Recorded usage is not a promise of reclaimable space.
- During a scan, refresh matches manually; the report updates automatically when scanning ends. Rescanning replaces old cards. A file-tree action resolves the matching entry in the current scan.
- The guide only copies a fixed settings address: `chrome://settings/clearBrowserData` for Chrome/Chromium, or `about:preferences#privacy` for Firefox. It does not launch a browser, run cleanup or create a cleanup history record. The user selects only cached files/pages/images in the browser, leaving cookies, history, passwords and site data unselected, then rescans. Rebuilding cache may slow the first visit to some pages.
- Identification does not change protection for hidden paths or application data, select items automatically, or authorize direct cache deletion. Rules, versions, sources and test status appear in the expandable matching details. Installed browser versions are unknown. Rules currently retain `validation: metadata-fixtures` and an empty `validatedAppVersions` list; the separate isolated Chrome experiment below does not validate standard installation paths or all supported browsers.

## Content preview boundaries

- Content preview is currently enabled only on Linux when the file and its open descriptor can be verified on a `/dev/`-backed ext2/ext3/ext4, XFS, Btrfs, F2FS, VFAT, exFAT, or ntfs3 filesystem. Network, FUSE, overlay, virtual, and unknown filesystems are refused. Windows/macOS previews return an explicit unsupported-platform result; their scanning and cleanup workflows remain available.
- Supported text files are decoded as UTF-8, reading at most the first **64 KiB**. Longer text is marked as truncated. Binary content and unsupported encodings are refused. HTML fragments inside supported text are displayed literally and are not executed.
- PNG, JPEG, and WebP images must be at most **8 MiB**, no more than **8,192 pixels on either side**, and no more than **16,000,000 pixels** in total. Headers and dimensions are checked before display. SVG, PDF, animated images, and other unsupported formats are refused.
- Each request is tied to the current scan ID and rechecks file and parent identity before and after reading through the same file handle. Changed files, symbolic links, hard links, protected paths, and unsupported filenames are refused. Each explicit preview reads the file afresh; contents are not stored in an application cache or activity log.
- Cloud-placeholder states are not comprehensively identified. Do not treat preview limits as a guarantee against cloud hydration or as a download-size limit: accessing an on-demand file may cause its provider to download content. Closing the preview hides its result; it does not claim to cancel a system read already in progress.

## Cleanup boundaries

- Dot-prefixed paths, hidden configuration locations, protected system/application-data paths, symbolic links, hard-linked files, unsupported names, and incomplete or unreadable scan results are refused. Any unsafe or changed descendant blocks the entire selected directory. Filesystem roots, home-directory roots, and the current scan root cannot be trashed as directories.
- A plan accepts at most **500 selections** before normalization. Selecting a parent directory and its children produces one parent operation; a blocked parent does not fall back to acting on the children.
- Validated directory manifests share a **10,001-entry limit per plan**, counting selected directory roots and their descendants. For one selected directory, that allows at most **10,000 descendants**. Multiple selected directories share the same limit.
- Plans are single use and must be confirmed within two minutes. A batch accepted within that period may continue beyond it. Identity and directory contents are checked again before the native operation.
- A journal must be written successfully before cleanup starts. A later journal failure stops further operations. Corrupted history is not silently replaced: explicitly clear the local history to reset it. Clearing history does not delete or restore user files.

To restore an item, expand **How to restore items** and use the system Trash:

1. Check the name, original path and removal time before selecting an item. For an uncertain result, inspect both its original location and the Trash.
2. Use the system’s **Restore** or **Put Back** action where available.
3. If a name conflicts, cancel first and compare both copies. Prefer keeping both or choosing another location if offered; do not overwrite without checking.
4. If the original folder is missing, use available system options to choose a location you have checked. Automatic recreation of the original folder is not guaranteed.
5. Check the restored name, location and contents in the file manager, then explicitly scan again in DiskHarbor.

Activity records retain the original Trash-operation result and do not monitor external restoration. They are not backups; DiskHarbor cannot recover permanently deleted items or an emptied Trash.

## Run from source

Use **Node.js 24 (recommended), or at least 22.12**, and npm. Run these commands from the repository directory.

```bash
npm ci
npm run dev
```

To build and run the production interface in Electron:

```bash
npm run build
npm start
```

`npm run preview` provides a browser-only interface preview. It cannot scan disks or perform file operations; use the Electron application for those workflows.

## Tests and packaging

```bash
npm test
npm run build
npm run test:desktop
npm run test:navigation
npm run test:cache
npm run test:scope
npm run test:space
npm run test:visibility
# Linux only
npm run test:restore
```

On Linux, the desktop integration test needs a graphical session with `DISPLAY`, or Xvfb:

```bash
xvfb-run -a npm run test:desktop
```

Build the production interface before running the desktop tests. `test:desktop`, `test:navigation`, `test:cache`, `test:scope`, `test:space` and `test:visibility` all need a graphical session or Xvfb on Linux and use isolated synthetic data with separate application profiles. `test:desktop` exercises native Trash operations, operation measurements and history recovery across two application processes without scanning personal folders; `test:cache` checks recognition, guidance, clipboard output and unchanged cleanup protection without performing cache cleanup. `test:scope` checks bilingual scope disclosure, recorded coverage, scan replacement and explained synthetic read failures. `test:space` exercises manual checks through the real desktop interface, signed and unknown outcomes, session retention and stale-result rejection using isolated fixtures. `test:visibility` checks defaults, excluded-item counts, mode-specific memory, visible-parent fallback, stale-request isolation, explicit cache navigation and unchanged directory-cleanup protection.

`test:restore` is Linux-only and also requires a production build, a graphical session or Xvfb, and the `dbus`, `libglib2.0-bin`, `gvfs` and `gvfs-daemons` packages. It creates a private D-Bus/GVFS session and separate XDG directories, keeps `HOME` unchanged and never uses the desktop’s GVFS session. Every restoration targets a URI verified to belong to its synthetic fixture. This exercises the system GIO CLI, not a new restoration API in DiskHarbor.

**Alpha.10 local validation:** 219 unit checks passed with 0 skipped and 0 failed. The production build, 22 native checks, 11 navigation checks and 7 cache checks passed. The visibility suite passed 11 groups, including both languages with display rules collapsed and expanded at 1024×700; every final row remains visible and hit-testable without overlapping the footer. Navigation was rerun after the layout correction and passed. Scope, manual-space and Linux restoration were not rerun locally this iteration; their current results are recorded separately in CI.

- The alpha.9 Linux restore suite passed six strict checks locally and in CI covering isolation, an ASCII name with spaces and punctuation, nested and empty directories, refusal to overwrite a conflicting name while preserving both copies, missing-parent handling, explicit rescanning with unchanged activity history, and harmless refusal of a repeated restoration while unrelated fixtures remain unchanged. The tested GIO environment recreated missing parents; other systems and unavailable volumes may behave differently.
- The separate Chinese-name diagnostic reproduced the same limitation locally on **GIO 2.72.4 / GVFS 1.48.2** and in CI on **GIO 2.80.0 / GVFS 1.54.4**: exit code 0, but the bytes restored under a literal `\xhh`-escaped name instead of the original name. This case is **not a passed restoration check**; the suite reports **`passed-with-limitations`**. The report links the relevant [GLib 2.72.4 restoration implementation](https://github.com/GNOME/glib/blob/2.72.4/gio/gio-tool-trash.c#L103). Successful CLI exit alone is insufficient: check name, location and contents. File-manager GUI restoration and Windows/macOS restoration have not been tested.

**Alpha.10 three-platform CI:** [verified run](https://github.com/asoming/diskharbor/actions/runs/36246180761), commit `e8144b3`. All jobs and production builds succeeded; 18 regular desktop reports passed with no renderer errors. The separate Linux GIO restoration report remains `passed-with-limitations` with six strict checks and the Chinese-name limitation above.

| Platform | Unit passed | Skipped | Failed | Native | Navigation | Cache | Scope | Space | Visibility |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Linux | 219 | 0 | 0 | 22 | 11 | 7 | 8 | 10 | 11 |
| Windows | 180 | 39 | 0 | 20 | 11 | 7 | 8 | 10 | 11 |
| macOS | 188 | 31 | 0 | 20 | 11 | 7 | 8 | 10 | 11 |

The four visibility-layout combinations passed at an actual content size of 1024×700 on Linux/Windows and 1024×668 on macOS. A prior test incorrectly required a 700 px macOS content height; it now records native bounds and verifies the actual smaller viewport while retaining all row-visibility and hit-testing assertions. Skips are not passes. Windows/macOS content preview remains disabled. Synthetic device errors and browser layouts do not establish physical-drive disconnection handling or installed-browser support.

A separate alpha.5 Linux **Google Chrome 152.0.7977.82** experiment used an isolated custom user-data directory and explicit disk-cache directory. After Chrome’s native cache-only action, the test asset’s server request count increased from 2 to 3, while cookie, localStorage and IndexedDB sentinels remained. This validates that isolated action only: it does **not** validate default installation paths, Firefox, Windows/macOS, bookmarks or passwords, and does not promote the built-in rules to native-browser validation.

These results do not certify every operating-system version or filesystem, accessibility conformance, or whole-disk performance.

**Alpha.10 Linux packages:** `release/0.1.0-alpha.10/` contains the verified local deb and portable archive. SHA256 checks passed; deb metadata is `diskharbor`, `0.1.0~alpha.10`, `amd64`.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `diskharbor_0.1.0-alpha.10_amd64.deb` | 101,498,232 | `8dfd36d1d9689f530f79308ab7ad5c2e022f3e4088e8190ece3f765a60864e46` |
| `diskharbor-0.1.0-alpha.10.tar.gz` | 122,865,269 | `8cbc56cae5c8a39674fda0a78cbb577e3598b92a101b7e34630967c91aa2cd78` |

The packaged Linux interface passed Chinese/English checks at 1024×700 and a 1320×860 review. The file table retains a scrollable viewport with no row clipping or footer overlap; keyboard display toggling and rule access work. The existing desktop launcher was switched to alpha.10 and its actual launched version verified using an isolated profile. Test windows were closed; earlier packages remain available.

The **35 MB package-size target remains unmet**. System-wide installation and clean-machine testing remain pending; local artifacts have not been published as a GitHub Release.

```bash
# Unpacked application
npm run pack

# Linux packages
npm run dist:linux
```

Windows and macOS build commands are also defined. Their installers, signed packages, and full platform compatibility still need validation:

```bash
# On Windows
npm run dist:win

# On macOS
npm run dist:mac
```

## Current limitations

- Browser-cache support currently provides standard-layout recognition and manual guidance only. Direct or automatic application-cache cleanup, duplicate-file detection and scan snapshots are not implemented.
- Content preview is limited to the Linux filesystems and formats described above; Windows/macOS content preview, document rendering, dark mode, and automatic in-app restoration are not available. System error text may remain in the operating system's language.
- Allocated size excludes directory metadata. Windows allocated-space metadata and special-volume handling remain incomplete; entries without allocation metadata show unknown, while overview totals include only known allocation and may therefore undercount. APFS shared extents and cloud-placeholder states are not identified. A native Trash call uses a path, so revalidation cannot eliminate every filesystem race. Journaling preserves checkpoints, but a crash between a native operation and its result checkpoint leaves an uncertain outcome requiring manual inspection.
- Linux restoration evidence covers the isolated GIO CLI only. The local and CI Chinese-name cases restored the bytes under an incorrect escaped name and are not counted as passed. File-manager GUI restoration, Windows/macOS restoration, unavailable volumes and complete recovery workflows remain unverified.
- The **35 MB package-size target is not met** by this Electron alpha. Check the generated artifacts for their actual sizes; no smaller package size is promised.
- Alpha.9 basic native scanning/cleanup, navigation, synthetic cache-layout, scope-interface and space-verification checks passed on Windows/macOS; content preview remains disabled, with its refusal verified. Signed packages and full compatibility remain pending. Their system Trash openers still have only mock coverage, and full manual restoration has not been tested.

## License

A project license has not been selected. The package is marked `UNLICENSED`; this repository does not currently grant an open-source license.
