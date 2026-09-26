# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor / **盘清** is a local desktop disk-space analyzer for Linux, Windows and macOS. Scan a chosen location, understand its contents, and review eligible items before moving them to the system Trash.

**0.1.0-alpha.11 is an unsigned prerelease, not a stable release.** Tests cover specific workflows and fixtures, not complete filesystem, cloud-provider or operating-system compatibility.

[Download alpha.11](https://github.com/asoming/diskharbor/releases/tag/v0.1.0-alpha.11): Linux x64 DEB/tar.gz, Windows x64 EXE, and separate macOS ARM64/Intel DMGs. Choose your OS and architecture, and verify the file against `SHA256SUMS.txt`. Known Mac performance failures are documented below. macOS packages are not notarized.

## What it does

- Scan metadata on demand; separate allocated space and logical size; show scope, timing, volume information, skipped entries and read errors.
- Browse a virtualized tree or file list with search, sorting, size/category filters, lazy expansion and pagination.
- Use arrows, Home/End, Page Up/Down, Space and Enter, with visible focus and Chinese/English at 100% and 200% zoom.
- Remember browsing paths, expansion, loaded pages and scrolling in the session; restore same-root rescans by path using new IDs.
- Filter hidden items and system/application data without changing totals or cleanup protection. Same-root scans retain these options; changing roots or restarting resets them.
- Inspect metadata, copy paths, reveal files, and view possible application associations and cloud-state evidence. Path matching does not prove ownership or installation.
- Explicitly preview supported text and images on verified local storage on all three platforms.
- Recognize selected standard Chrome, Chromium and Firefox cache layouts and provide manual cache-only guidance.
- Review files or eligible whole folders, confirm with a native dialog, and move them to system Trash; stop operations that have not started.
- Keep up to 50 local operation records with per-item checkpoints and conservative crash recovery.
- Compare available space manually from scan start, or inspect separate before/after-operation measurements.
- Open system Trash and follow restoration guidance. There is no automatic restore, permanent-delete or empty-Trash action.

No account is required. Scanned paths and contents are processed locally; the application does not upload them or send telemetry.

## Scanning, display and preview boundaries

Scanning covers only the selected root and does not follow symbolic links. Detected volume/mount boundaries require a separate scan. Linux uses mount-table information, including bind mounts; Windows/macOS use native volume metadata. Unknown metadata stays unknown. A completed scan is not a transaction snapshot or proof of whole-disk coverage.

Stopping waits for any current operating-system read, retains discovered results, and prevents starting another scan prematurely. Up to 100 read-error details can be reviewed. Retrying a failed scope replaces the scan; it does not merge totals, elevate privileges or change permissions.

Display rules combine dot-prefixed paths and known system/application locations with native hidden/system flags where available. Hidden contents still count toward sizes and parent proportions. Excluded counts describe the current query, not the volume. Showing a protected item does not make it eligible for cleanup.

Navigation memory is bounded to 16 views, 16 expanded folders per view, 500 automatically restored rows per folder and 2,000 rows overall. Hidden or unavailable remembered locations fall back to an available ancestor. Selections and open details are not automatically restored.

Preview requires an explicit action and the current scan ID. File, parent and opened-object identities are checked before and after bounded reads. Content is not persisted in an application cache or history.

- UTF-8 text: at most the first **64 KiB**, with truncation indicated. HTML fragments remain literal text; binary or unsupported encodings are refused.
- PNG/JPEG/WebP: at most **8 MiB**, **8,192 pixels per side** and **16,000,000 pixels** total. SVG, PDF, animation and unsupported formats are refused.
- Linux requires a verified local `/dev/`-backed filesystem from the supported allowlist. Network, FUSE, overlay, virtual and unknown filesystems are refused.
- Windows/macOS use compiled native policy and metadata/read helpers. Missing policy, unverifiable metadata, nonlocal storage, placeholders, reparse/symlink paths or changed identities cause refusal; there is no permissive Node content-read fallback.

Native placeholder protections are conservative, not evidence that every cloud provider has been tested or every provider race eliminated. Local availability does not establish that a file was never synced.

## Cleanup, history and recovery

Cleanup refuses protected hidden/configuration/system/application-data paths, links, shared hard links, unsupported names and incomplete results. Every descendant of a selected directory must pass; one blocked descendant blocks that entire directory. Filesystem roots, home roots and the scan root are protected.

- At most **500 selections** before parent/child normalization. A selected parent replaces selected descendants; a rejected parent does not fall back to acting on its children.
- Directory manifests share a **10,001-node limit per plan**, including selected directory roots: at most 10,000 descendants for one directory.
- Plans are single-use and must be accepted within **two minutes**. The native dialog is the final confirmation; identities and folder contents are rechecked before each operation.
- Only native Trash operations are used. Failure never falls back to permanent deletion. Stopping remaining work does not undo completed or in-flight operations.
- A durable journal must be written before operations start. Later write failures stop further work. Corrupted history requires explicit reset, not silent replacement.
- On restart, pending items become cancelled and processing items become uncertain. Work is never automatically resumed, and source absence is not proof of success.

Native Trash APIs use paths, so checks cannot eliminate every filesystem race. History records an operation; it is not a backup.

To restore, check the original name/path and removal time, then use the system's Restore/Put Back action. On a name conflict, cancel and compare both copies before choosing an available keep-both or alternate-location option. Missing original folders are not guaranteed to be recreated. Check the restored **name, location and contents**, then scan again; history does not monitor external restoration. For uncertain results, inspect both the original location and Trash. DiskHarbor cannot recover permanently deleted or emptied-Trash items.

**Linux restoration limitation:** isolated GIO CLI tests passed six strict ASCII/directory/conflict checks, but Chinese-name diagnostics on GIO 2.72.4/GVFS 1.48.2 and GIO 2.80.0/GVFS 1.54.4 preserved bytes while restoring a literal `\xhh`-escaped name. That case is **not passed**; the report is `passed-with-limitations`. See the [GLib restoration implementation](https://github.com/GNOME/glib/blob/2.72.4/gio/gio-tool-trash.c#L103). File-manager GUI restoration and Windows/macOS restoration remain unverified.

## Space measurements and browser caches

Measurements describe the **entire containing volume**, with both timestamps, total capacity and available space. A signed difference is shown only when samples and root identity are comparable. Unknown is not zero. Same-volume Trash moves usually do not immediately free space; other writers, snapshots and delayed operations also affect the difference. It is not guaranteed space released by DiskHarbor.

Manual checks compare scan start with an explicit later check; operation records use a separate before/after-operation interval. Manual results stay in the session for that scan, do not update file lists or history, and clear on replacement. Legacy differences are labeled unverified; interrupted measurements never fabricate a final sample.

Cache matching uses only current scan metadata, with at most 50 findings. Standard paths and expected structure are required; no match does not mean no cache. Recorded size is not a reclaimable-space promise. Custom/sandboxed layouts may be missed; installed browser versions are not inferred.

The guide copies fixed settings addresses and asks users to select cached files/pages/images while leaving cookies, history, passwords and site data unselected. It does not run cleanup or relax protected-path rules. Browser outcomes are not monitored; rescan afterward. Firefox rules record native-browser validation for version 156.0.1; Chrome/Chromium rules remain metadata-fixture-only. The installed browser version remains unknown.

## Build and run

Use **Node.js 24** and npm. Windows also needs Python 3 and Visual Studio 2022 Build Tools with **Desktop development with C++** and the Windows SDK. macOS needs Python 3 and Xcode Command Line Tools. Native helpers are compiled for the installed Electron version during `prebuild` and `pretest`; fix failed native builds rather than bypassing protection.

```bash
npm ci
npm run build
npm start
```

For development, run `npm run build:native` before `npm run dev`. `npm run preview` is a browser-only UI preview; it cannot scan or operate on files.

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
npm run test:performance
npm run test:index
```

Desktop suites need a production build and a graphical session. On Linux use `DISPLAY` or `xvfb-run -a`; retain the Electron sandbox and configure its helper correctly. Do not use `--no-sandbox` as a workaround.

`test:performance` creates 100,000 real same-level files plus nested fixtures and a 1,000,000-record synthetic index. `test:index` measures the production index without Electron; its memory result is not a whole-application measurement. Generated fixtures can require substantial filesystem metadata, memory and time.

Linux-only `npm run test:restore` additionally needs `dbus`, `libglib2.0-bin`, `gvfs` and `gvfs-daemons`. It uses private D-Bus/XDG state and only its own verified Trash URIs, preserving the CLI Unicode limitation above.

```bash
npm run pack        # unpacked application
npm run dist:linux  # Linux: deb and tar.gz
npm run dist:win    # Windows: NSIS installer
npm run dist:mac    # macOS: DMG
```

Build on the target OS. Outputs are under `release/0.1.0-alpha.11/`. These are unsigned alpha artifacts; macOS ad-hoc signatures are not a developer identity, notarization or Gatekeeper distribution approval.

## Verification evidence

**Core regression:** [four-platform run 36252600636](https://github.com/asoming/diskharbor/actions/runs/36252600636), application commit `b9096b78bdf5b75b7312bfcebdf1fb722faedf8b`. Each platform ran 257 unit tests: Linux 254 passed/3 platform skips, Windows 218/39, and each Mac architecture 225/32; no failures. All 24 regular desktop reports passed with no renderer errors. Linux restoration is separately `passed-with-limitations`, as described above.

**Performance has known failures:** [run 36252607354](https://github.com/asoming/diskharbor/actions/runs/36252607354) at the same commit. Budgets remain sort completion p95 ≤200ms, cancellation feedback ≤1s/settlement ≤3s, and million-record whole-app peak ≤1.5 GiB. **Neither Mac architecture met all budgets in this run.**

| Platform | Sort completion p95 | Cancellation feedback | 1M whole-app peak | Result |
| --- | ---: | ---: | ---: | --- |
| Linux x64 | 116.2ms | 25.9ms | 1.2743 GiB | Passed |
| Windows x64 | 110.0ms | 26.8ms | 1.0497 GiB | Passed |
| macOS Intel | 265.9ms | 90.7ms | 1.1865 GiB | Sort budget missed |
| macOS ARM64 | Not reached | 2,309ms | Not reached | Cancellation budget missed |

Linux, Windows and Intel Mac each completed a scan of 100,129 real files, including 100,000 empty siblings and depth 82, and retained a million complete synthetic records. Each recorded 60 fixed sorts with exactly one production query per sort; p95 uses nearest rank after stable DOM/frame completion. Intel Mac had 27/60 samples above 200ms and a maximum of 314.3ms. Its seven functional checks and memory budget passed, but its overall performance result did not.

ARM64 stopped at the initial cancellation assertion. Its first frame arrived after 2,216.4ms, with the scan already cancelled; settlement was observed after 2,312.4ms. The window and document were focused and visible. Existing evidence does not distinguish renderer scheduling from compositor delay; no specific cause is claimed. Later ARM64 sorting, memory and accessibility stages were not run in this final performance attempt. Prior passing runs do not override this failure.

These are warm-cache metadata measurements on recorded CI hardware, not a controlled 4-core/8-GiB reference machine or cold-disk throughput claim. Memory sums process working sets at 100ms intervals during scan/memory phases, conservatively double-counting shared pages; synchronous sampling is paused during timed interactions. All raw samples and failures are retained. Keyboard/ARIA and Chinese/English 200% zoom passed on the three runners that reached those stages; manual screen-reader listening remains unverified.

The final local Linux/X11 build passed all seven performance checks: sort p95 **111.1ms**, whole-app million-record peak **1.4378 GiB**, leaving about 63.7 MiB below the budget. An earlier separate core-only million-index test measured first-page p95 1,014.7ms and deep-page p95 4,964.7ms. The 200ms target concerns the real-100k interface workload, not every million-record query.

**Installation, upgrade and browser validation:** [four-platform run 36252610945](https://github.com/asoming/diskharbor/actions/runs/36252610945), the same application commit. All four jobs passed five package checks and four browser checks. Packages were installed on disposable runners, upgraded from the actual alpha.10 source (`4272cff052a247c7703069c4d2c28b9ef69852d7`), launched with the renderer sandbox, checked for the custom icon and fixture preference/history preservation, then uninstalled. Linux used a DEB; Windows used a current-user NSIS installer; macOS copied and replaced an app bundle from a read-only DMG. The Mac check is not Gatekeeper approval or a pkg-installer test.

The hosts were Ubuntu 24.04 x64, Windows Server 2025 x64, macOS 26.6.2 ARM64 and macOS 15.7.9 Intel. This does not establish Windows 10/11 desktop or older macOS compatibility.

Firefox **156.0.1** used isolated profiles in its actual standard profile/cache layout on all four runners. Cached resources survived restart; native cache-only clearing caused a fresh request while cookie, localStorage, bookmark and profile-file sentinels remained. Clearing used `nsIClearDataService.CLEAR_NETWORK_CACHE` through privileged loopback WebDriver, not the settings GUI. The application itself provides manual guidance and does not run that service.

The earlier Linux Chrome **152.0.7977.82** experiment used custom profile/cache directories and preserved cookie/localStorage/IndexedDB sentinels after native cache-only clearing. It does not validate default Chrome paths, Chromium, bookmarks or passwords.

## Remaining limits

- Real cloud-provider hydration, macOS TCC dialogs, physical removable-drive disconnection and manual assistive-technology use still need field validation. Simulated failures are not real unplug tests.
- Allocated totals exclude directory metadata, reserved space and snapshot accounting. Unknown allocations can make known-byte summaries incomplete; APFS shared extents are not deduplicated. Sparse/compressed metadata checks are not universal filesystem certification.
- No automatic cache cleanup, duplicate-file finder, scan snapshots, document rendering, dark mode or automatic restoration is provided.
- No signed/notarized stable distribution is available. Package tests on disposable runners do not establish every installer, OS version or enterprise policy combination.

## License

No license has been selected. The package is marked **UNLICENSED**; this repository does not grant an open-source license.
