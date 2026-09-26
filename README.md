# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor is a local desktop disk space analyzer. Explore what occupies your storage, inspect files and folders, and review selected items before moving them to the system Trash.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

**0.1.0-alpha.5 — an early desktop alpha.** This iteration adds browser-cache recognition and guidance for cleaning through the browser’s own settings. It does not directly delete browser caches. Three-platform CI and local Linux package checks have passed, including scanning, native cleanup, navigation and synthetic cache-layout integration. Renderer sandboxing remains enabled and production assets use the application protocol. Windows/macOS content preview remains disabled. Clean-machine installation, signed Windows/macOS packages, and complete platform compatibility remain pending.

The first stable release targets the same core workflows on Linux, Windows, and macOS. These alpha checks cover the tested workflows, not complete platform support.

## Available functionality

- **Storage overview:** real scan results grouped by category, with allocated space and logical file size shown separately.
- **File explorer:** an expandable file tree with lazy loading, pagination, virtualized rows, keyboard navigation, sorting, search, and size/category filters.
- **Session navigation memory:** return to a browsing scope with its filters, sorting, expanded folders and scroll position. A completed rescan of the same root restores remembered locations by exact path, using the new scan's IDs.
- **Scan cancellation:** request a stop while keeping discovered results available. A pending filesystem call must return before the scan is reported as cancelled; a visible waiting state follows page navigation, and a new scan cannot begin while the old one remains active.
- **Read-error review:** inspect up to 100 recorded failures with paths and explanations. Explicitly rescan a failed directory, or the containing directory when a file failed. The new scan replaces the current scope and totals; results are not merged. An action lets you rescan the original scope again.
- **File details:** inspect metadata and paths, reveal an item in the system file manager, and copy its path.
- **On-demand content preview:** explicitly preview supported UTF-8 text and PNG, JPEG, or WebP images on verified local Linux filesystems. Inspecting an item does not automatically read its contents.
- **Browser-cache guidance:** identify selected standard Chrome, Chromium and Firefox cache layouts from already-scanned metadata, inspect recorded usage and the matching basis, copy a fixed browser settings address, and follow manual cache-only cleanup steps.
- **Reviewed file and folder cleanup:** select ordinary files or eligible directories, inspect the plan, and confirm through a native dialog. A directory is moved as one native Trash item only after its complete indexed contents pass metadata checks and match the current filesystem. A blocked directory is not partially cleaned, and a failed Trash operation never falls back to permanent deletion.
- **Cleanup progress and cancellation:** see individual operation results and stop operations that have not started. An in-flight native Trash call may finish; cancellation does not undo completed moves.
- **System Trash access:** open the system Trash and follow the platform's manual restoration instructions. DiskHarbor does not restore files automatically or empty the Trash. Restoration depends on the item still being available and the system's capabilities.
- **Durable local history:** save checkpoints before native operations and after individual results, retaining up to 50 operation records. Interrupted work is not automatically resumed; pending items become cancelled and items last recorded as processing become uncertain results. File absence is never treated as proof of a successful move.
- **Space verification:** record the observed change in volume free space separately from Trash results. Moving an item to the same volume's Trash usually does not immediately free space.
- **Local, bilingual use:** Chinese and English interfaces without an account or uploading scanned filenames, paths, or file contents.
- **Linux application launcher:** the desktop entry supports the Chinese name **盘清** as well as **DiskHarbor**.

## Scanning and retry boundaries

- Cancellation stops scheduling new scan work. It cannot forcibly interrupt every operating-system read, so a blocked read may leave the application in the waiting state until that call returns. You can continue browsing discovered results; they are marked incomplete when cancellation finishes.
- Error details are capped at **100 entries** even when the total failure count is higher. Retrying is a user action after the active scan ends. It does not grant elevated permissions or alter filesystem permissions.
- A retry starts a separate scan of the eligible failed directory or a failed file's parent directory within the previous scan root. The previous totals are replaced rather than combined with the new results. Unsupported filenames cannot become retry paths.
- File-tree and file-list navigation memory lives only in the current application session. It includes search, minimum logical size, sorting, visible columns, browsing scope, expanded folders, loaded pages and scroll position. Same-root rescan restoration waits for the replacement scan to complete; a location absent from the new results falls back to its nearest remembered ancestor available in that scan. Absence from scan results does not prove that a folder was deleted. Changing the scan root or restarting clears this memory. A remembered keyboard row is restored only when its exact path is among the loaded rows; cleanup checkboxes and file details are not automatically restored.
- Navigation memory keeps at most **16 views**, with **16 expanded folders per view**. Automatic restoration is capped at **500 rows per folder** and **2,000 rows in total**; the interface explains the limit and lets you continue loading manually. Restoration remains pending until the replacement scan completes, including when it is cancelled.

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

To restore an item, choose **Open system Trash**, find and select the item in the system file manager, then use its **Restore** or **Put Back** action where available. Follow the system's prompts for destination or name conflicts. Activity records are not backups; items removed from the Trash cannot be recovered by DiskHarbor.

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
```

On Linux, the desktop integration test needs a graphical session with `DISPLAY`, or Xvfb:

```bash
xvfb-run -a npm run test:desktop
```

Build the production interface before running the desktop tests. `test:desktop`, `test:navigation` and `test:cache` all need a graphical session or Xvfb on Linux and use isolated synthetic data with separate application profiles. `test:desktop` exercises native Trash operations without scanning personal folders; `test:cache` checks recognition, guidance, clipboard output and unchanged cleanup protection without performing cache cleanup.

**Alpha.5 [three-platform CI](https://github.com/asoming/diskharbor/actions/runs/36234449356) passed** for commit [`e50e6b7`](https://github.com/asoming/diskharbor/commit/e50e6b77ed72abf631afe407f08402f1c6d5656d), with **0 failures**. All nine native, navigation and cache reports record `result: passed` and `errors: []`.

| Platform | Unit checks passed | Skipped | Production build | Native Electron checks | Navigation checks | Cache checks |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Ubuntu | 126 | 0 | Passed | 16 | 11 | 7 |
| Windows | 93 | 33 | Passed | 14 | 11 | 7 |
| macOS | 100 | 26 | Passed | 14 | 11 | 7 |

Local Linux validation also passed 126 unit checks with 0 skipped and 0 failed, production build, 16 native checks, 11 navigation checks and 7 cache checks. Skipped checks are not counted as passes; platform exclusions include Linux-only content preview, filesystem/mount fixtures and POSIX permissions.

- The cache checks on all three platforms cover anchored matching and real indexed sizes, rejection of forged report inputs and arbitrary settings identifiers, guidance-only UI, fixed-address clipboard output, unchanged protected-path rejection, file-tree navigation and stale-card removal after a new scan. Fixtures and cleanup history remain unchanged. These use synthetic layouts, not installed-browser validation.
- A separate Linux **Google Chrome 152.0.7977.82** experiment used an isolated custom user-data directory and explicit disk-cache directory. After Chrome’s native cache-only action, the test asset’s server request count increased from 2 to 3, while cookie, localStorage and IndexedDB sentinels remained. This validates that isolated action only: it does **not** validate default installation paths, Firefox, Windows/macOS, bookmarks or passwords, and does not promote the built-in rules to native-browser validation.
- Native/navigation checks cover scanning, real directory moves to Trash, parent/child normalization, change rejection, cancellation, durable history, partial-scan handling and browsing-memory restoration.
- Linux preview coverage includes stale-scan rejection, real UTF-8/PNG reads, literal HTML display, opt-in reads, image loading and focus restoration. Windows/macOS preview remains explicitly refused.
- Opening the system Trash on Windows/macOS still has mock coverage only. Full manual restoration, clean-machine installation and signed installers have not been validated.

These results do not certify every operating-system version or filesystem, accessibility conformance, or whole-disk performance.

Alpha.5 Linux packages are available locally in `release/0.1.0-alpha.5/`. Both passed `SHA256SUMS` verification; the deb metadata records version `0.1.0~alpha.5` and architecture `amd64`.

| Artifact | Size and validation |
| --- | --- |
| `diskharbor_0.1.0-alpha.5_amd64.deb` | 101,482,160 bytes · 96.8 MiB · SHA256 verified |
| `diskharbor-0.1.0-alpha.5.tar.gz` | 122,847,922 bytes · 117.2 MiB · SHA256 verified |

The packaged GUI identified three synthetic browser layouts containing four fixture files. Chinese and English guidance passed 1024×700 review without horizontal overflow, Firefox tree navigation worked, and the console recorded no errors or warnings. The local desktop entry passed format, executable-permission and trust checks; its stable launch script started the application displaying `LINUX 0.1.0-alpha.5`.

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
- The **35 MB package-size target is not met** by this Electron alpha. Check the generated artifacts for their actual sizes; no smaller package size is promised.
- Alpha.5 basic native scanning/cleanup, navigation and synthetic cache-layout checks passed on Windows/macOS; content preview remains disabled, with its refusal verified. Signed packages and full compatibility remain pending. Their system Trash openers still have only mock coverage, and full manual restoration has not been tested.

## License

A project license has not been selected. The package is marked `UNLICENSED`; this repository does not currently grant an open-source license.
