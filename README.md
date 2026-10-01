# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor / **盘清** is a local desktop disk-space analyzer for Linux, Windows and macOS. Scan a chosen location, understand its contents, and review eligible items before moving them to the system Trash.

**0.1.0-alpha.13 is an unsigned prerelease, not a stable release.** Tests cover specific workflows and fixtures, not complete filesystem, cloud-provider or operating-system compatibility.

[Download alpha.13](https://github.com/asoming/diskharbor/releases/tag/v0.1.0-alpha.13): Linux x64 DEB/tar.gz, Windows x64 EXE, and separate macOS ARM64/Intel DMGs. Choose your OS and architecture, and verify the file against `SHA256SUMS.txt`. Historical alpha.12 measurements and retained earlier performance failures are documented below. macOS packages are not notarized.

## Access and interface (alpha.16 development source)

Current source is `0.1.0-alpha.16`. Before a whole-drive Windows scan, choose administrator authorization via system UAC, scan directly, or cancel. Mac root/home scans offer access settings; the compact Access control opens Full Disk Access or Files & Folders. Grant access in macOS, then rescan. Opening settings never means access was granted.

The sidebar shares the content background, navigation highlights move smoothly, and pages briefly fade in. System reduced-motion preferences are respected. Repeated captions are removed, with display and access details available on demand. By product decision, interactive Windows/Mac permission flows now rely on user feedback rather than a mandatory pre-release test gate. Basic build and code checks remain.

## Storage charts (alpha.15)

Added in alpha.15: A dedicated Storage charts page adds pie and bar charts, a two-level treemap, folder drill-down, Up/breadcrumb navigation, and links to the file tree. Switch between allocated and logical bytes; hover or focus shapes for paths/sizes, or use the HTML data table. Charts use the real scan index without reading file contents.

Each level shows the largest items individually and groups the rest. Items hidden by display settings retain a separate aggregate in the full total; unknown allocations never fall back to logical bytes. Percentages use known bytes in the current directory; volume free space is separate. The public alpha.13 download above does not include alpha.14/15 changes. Chart checks are wired into four-target GitHub Actions.

Compared with the [official TreeSize feature list](https://www.jam-software.com/treesize/features.shtml) and [chart manual](https://manuals.jam-software.com/treesize/EN/charts.html), useful next priorities are exact extension/file-age statistics, saved scans/growth comparison, duplicate detection, chart/CSV/PDF export and dark mode. Scheduled scanning, cloud/network connectors and NTFS-specific acceleration are further work. TreeSize editions differ; Professional capabilities do not all belong to Free.

[Alpha.15 four-target CI](https://github.com/asoming/diskharbor/actions/runs/36825185832), at implementation `f6164f3`, passed: 325 unit cases per target, zero failures, and 13/40/43/43 platform skips for Linux/Windows/Mac ARM/Mac Intel. All 353 checks in 32 regular desktop reports passed, including eight chart checks per target. Coverage includes real indexed totals, both measures, directory drill-down/focus, tree navigation, hidden items, 200% layout and stale-response rejection, with zero chart Trash calls. Six Linux GIO restoration checks are recorded separately with the CLI Unicode escaping limitation retained. These results do not replace interactive UAC/TCC or physical-device acceptance.

## Completed alpha.14 release preparation

The alpha.14 baseline adopted [MIT](LICENSE). The alpha.13 download above remains the earlier prerelease build and does not include this work. Original production dependency notices are collected in `THIRD_PARTY_LICENSES.txt`, checked against locked versions and regenerated during builds, and shipped with the app. Electron/Chromium retain their separately distributed runtime notices.

- New bilingual Mac guidance covers folder permissions, Full Disk Access and rescanning after access changes; Linux access-denied guidance covers file permissions and mount availability. It does not query or assume TCC authorization, or change permissions automatically. Mac guidance follows [Apple's file and folder access documentation](https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac).
- `npm run test:storage` uses only owned Linux fixtures, private D-Bus/GVfs Trash and user/mount namespaces. Ten native checks passed: original names/content restored for Unicode and special characters, directory restore, conflict refusal, remeasurement after removing only an owned Trash item, bind boundaries, unmount/remount, external writes and tmpfs resizing. Physical unplugging, file-manager GUI restoration and Windows/Mac restoration remain unverified. The existing GIO CLI escaping limitation remains recorded.
- Fixed lost focus after closing cleanup review: capture the opener before requesting the plan, then restore it after the background becomes interactive. A cross-platform regression check is included.
- `npm run test:accessibility` passed five native AT-SPI checks on Linux X11: bilingual names/descriptions, tree expansion and selection, modal focus, and return to the opener. The isolated process explicitly enables its accessibility bridge; automatic screen-reader detection and Orca listening remain unverified, as do Windows NVDA, Mac VoiceOver and Wayland acceptance. It requires `python3-gi`, AT-SPI and isolated D-Bus; missing dependencies do not count as a pass.
- The manual **Signed stable build candidates (manual, no publication)** workflow requires a committed stable version, exact source SHA, clean checkout and distribution credentials. It verifies signing identities, notarization/tickets and package hashes, and only produces candidates; it never publishes automatically. Run `node scripts/release-preflight.cjs all` to inspect prerequisites. A nonzero exit is expected for the current alpha or missing credentials.

At source `3292d53`, [four-target CI](https://github.com/asoming/diskharbor/actions/runs/36822801716) completed Linux x64, Windows x64 and macOS ARM64/Intel builds. Each target reported 314 unit cases with no failures (13/40/43/43 platform-specific skips, respectively); all 321 checks across 28 regular desktop reports passed.

The [single Mac ARM performance run](https://github.com/asoming/diskharbor/actions/runs/36822856783) at the same source passed all seven checks against unchanged budgets. Sort completion p95 was **116 ms**, maximum **680 ms**; cancellation feedback was **314.7 ms**, and peak whole-app memory was **1.3112 GiB** with one million synthetic metadata records. All samples remain recorded, including three sorts exceeding 200 ms. These measurements cover that CI host only; they do not establish the cause of the earlier ARM cancellation failure.

Signing uses the GitHub `stable-release` Environment: Windows Secrets `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and Variable `EXPECTED_WINDOWS_CERT_SHA256`; Mac Secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and Variable `APPLE_TEAM_ID`. Restrict it to trusted refs and configure reviewers before adding credentials; never put them in source or chat. Actual signing has not run because distribution identities are unavailable.

Interactive Windows/Mac permission acceptance has moved to user feedback by product decision. Other declared physical-drive/cloud-provider checks, system restoration, human screen-reader checks and signing/notarization remain separately tracked. Successful CI builds do not verify those items. The first Windows baseline is Windows 11 x64; Windows 10 is not an added mandatory gate. Later features such as snapshots, duplicates and dark mode do not block the first release.

## What it does

- Scan metadata on demand; separate allocated space and logical size; show scope, timing, volume information, skipped entries and read errors.
- Browse a virtualized tree or file list with search, sorting, size/category filters, lazy expansion and pagination. A bounded sort cache reduces repeated work, and refreshing sort/filter results keeps the tree viewport in place.
- Use arrows, Home/End, Page Up/Down, Space and Enter, with visible focus and Chinese/English at 100% and 200% zoom.
- Remember browsing paths, expansion, loaded pages and scrolling in the session; restore same-root rescans by path using new IDs.
- Filter hidden items and system/application data without changing totals or cleanup protection. Same-root scans retain these options; changing roots or restarting resets them.
- Inspect metadata, copy paths, reveal files, and view possible application associations and cloud-state evidence. Path matching does not prove ownership or installation.
- Explicitly preview supported text and images on verified local storage on all three platforms.
- Recognize selected standard Chrome, Chromium and Firefox cache layouts and provide manual cache-only guidance.
- Review files or eligible whole folders, confirm with a native dialog, and move them to system Trash; stop operations that have not started.
- Explicitly allow ordinary Windows hidden-attribute items for one cleanup review; this option starts off and rebuilds the plan when changed.
- Explicitly reopen Windows as administrator when needed; scanning does not elevate automatically or change file permissions.
- Keep up to 50 local operation records with per-item checkpoints and conservative crash recovery.
- Compare available space manually from scan start, or inspect separate before/after-operation measurements.
- Open system Trash and follow restoration guidance. There is no automatic restore, permanent-delete or empty-Trash action.

No account is required. Scanned paths and contents are processed locally; the application does not upload them or send telemetry.

## Scanning, display and preview boundaries

Scanning covers only the selected root and does not follow symbolic links. Detected volume/mount boundaries require a separate scan. Linux uses mount-table information, including bind mounts; Windows/macOS use native volume metadata. Unknown metadata stays unknown. A completed scan is not a transaction snapshot or proof of whole-disk coverage.

Stopping waits for any current operating-system read, retains discovered results, and prevents starting another scan prematurely. Up to 100 read-error details can be reviewed. Retrying a failed scope replaces the scan; it does not merge totals, elevate privileges or change permissions.

On Windows, **Reopen as administrator** separately requests UAC consent or administrator credentials. Cancelling keeps the existing window and results. After a successful restart, manually select the location and scan again. Administrator access does not guarantee every file is readable or remove cleanup protections; mapped network drives may be unavailable.

Display rules combine dot-prefixed paths and known system/application locations with native hidden/system flags where available. Hidden contents still count toward sizes and parent proportions. Excluded counts describe the current query, not the volume. Showing a protected item does not make it eligible for cleanup.

Navigation memory is bounded to 16 views, 16 expanded folders per view, 500 automatically restored rows per folder and 2,000 rows overall. Hidden or unavailable remembered locations fall back to an available ancestor. Selections and open details are not automatically restored.

Preview requires an explicit action and the current scan ID. File, parent and opened-object identities are checked before and after bounded reads. Content is not persisted in an application cache or history.

- UTF-8 text: at most the first **64 KiB**, with truncation indicated. HTML fragments remain literal text; binary or unsupported encodings are refused.
- PNG/JPEG/WebP: at most **8 MiB**, **8,192 pixels per side** and **16,000,000 pixels** total. SVG, PDF, animation and unsupported formats are refused.
- Linux requires a verified local `/dev/`-backed filesystem from the supported allowlist. Network, FUSE, overlay, virtual and unknown filesystems are refused.
- Windows/macOS use compiled native policy and metadata/read helpers. Missing policy, unverifiable metadata, nonlocal storage, placeholders, reparse/symlink paths or changed identities cause refusal; there is no permissive Node content-read fallback.

Native placeholder protections are conservative, not evidence that every cloud provider has been tested or every provider race eliminated. Local availability does not establish that a file was never synced.

## Cleanup, history and recovery

Cleanup blocks hidden items by default. Windows items with an ordinary **H (hidden) attribute** can be explicitly allowed in that cleanup review when offered; the checkbox starts unchecked, is not saved, and each change rebuilds and rechecks the plan. Closing review or changing scans resets the choice. This does not allow system attributes/paths, AppData, dot-prefixed configuration paths, cloud placeholders, links, shared hard links, unsupported names or incomplete results. Every descendant of a selected directory must pass; one blocked descendant blocks that entire directory. Filesystem roots, home roots and the scan root remain protected, including in administrator mode.

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
npm run test:cleanup-review
npm run test:navigation
npm run test:cache
npm run test:scope
npm run test:space
npm run test:visibility
npm run test:performance
npm run test:index
```

Desktop suites need a production build and a graphical session. On Linux use `DISPLAY` or `xvfb-run -a`; retain the Electron sandbox and configure its helper correctly. Do not use `--no-sandbox` as a workaround.

`test:cleanup-review` checks the hidden-item option, plan replacement, failure/retry, stale responses and cancelled final confirmation. Windows uses self-created files with real hidden/system attributes; other platforms explicitly simulate hidden eligibility for UI checks. It does not approve UAC or move files to Trash.

`test:performance` creates 100,000 real same-level files plus nested fixtures and a 1,000,000-record synthetic index. `test:index` measures the production index without Electron; its memory result is not a whole-application measurement. Generated fixtures can require substantial filesystem metadata, memory and time.

Linux-only `npm run test:restore` additionally needs `dbus`, `libglib2.0-bin`, `gvfs` and `gvfs-daemons`. It uses private D-Bus/XDG state and only its own verified Trash URIs, preserving the CLI Unicode limitation above.

```bash
npm run pack        # unpacked application
npm run dist:linux  # Linux: deb and tar.gz
npm run dist:win    # Windows: NSIS installer
npm run dist:mac    # macOS: DMG
```

Build on the target OS. Outputs are under `release/0.1.0-alpha.16/`. These are unsigned alpha artifacts; macOS ad-hoc signatures are not a developer identity, notarization or Gatekeeper distribution approval.

## Alpha.13 verification

**Core regression:** [four-platform run 36514125592](https://github.com/asoming/diskharbor/actions/runs/36514125592), source `ec085f1493d38df5e16e4fdfcbf40cd9c8dc5383`, passed on Linux x64, Windows x64 and both Mac architectures. Each platform ran 299 unit tests with zero failures: Linux 286 passed/13 platform skips, Windows 260/39, and each Mac architecture 257/42. All 28 regular desktop reports passed 317 checks with no renderer errors. Windows used verified real H/S attributes, an explicitly denied directory, native token detection and four separate-process handoffs; the eight cleanup-review UI checks never moved files to Trash. Linux restoration remains separately `passed-with-limitations`.

**Windows performance:** [run 36514129839](https://github.com/asoming/diskharbor/actions/runs/36514129839), source `ec085f1493d38df5e16e4fdfcbf40cd9c8dc5383`, passed all seven checks with unchanged budgets. This is the same source used for the core regression above. All 100,129 real files and 1,000,000 synthetic records were retained. The 60 sort samples each used one query: completion p95 **62.8ms**, maximum **93.6ms**; cancellation feedback **22.5ms**, observed settlement **24.88ms**; whole-app peak **1.0621 GiB**. Chinese/English 200% keyboard checks passed. These are Windows Server 2025 CI measurements, not cold-disk throughput or new alpha.13 measurements on every platform.

**Installation and upgrade:** [four-platform run 36514126157](https://github.com/asoming/diskharbor/actions/runs/36514126157), also source `ec085f1493d38df5e16e4fdfcbf40cd9c8dc5383`, passed five package and four Firefox checks per platform, with no errors. The upgrade baseline was published alpha.12 (`06ae359cf75ecef412275f6422200fc93e1059b7`); fixture preferences/history and the renderer sandbox were preserved. Firefox 156.0.1 cache-only checks passed on all four hosts. Packages remain unsigned; Mac installation means copying an app bundle from a DMG, not Gatekeeper approval. Hosts were Ubuntu 24.04.5 x64, Windows Server 2025 (10.0.26100) x64, macOS 26.6.2 ARM64 and macOS 15.7.9 Intel.

Real UAC secure-desktop consent/cancellation, switching to a different administrator account, and Windows 10/11 desktop behavior remain unverified. Token, ACL and process-handoff tests do not exercise the Windows consent desktop. Administrator access does not certify whole-disk coverage.

## Alpha.12 historical baseline

The following records belong to alpha.12. They are retained historical evidence, not verification of alpha.13's new permission and hidden-item behavior.

**Core regression:** [four-platform run 36293114784](https://github.com/asoming/diskharbor/actions/runs/36293114784), source `abe3ee40ad46472dd95031ecf07eb3b82eaa4857`. Each platform ran 263 unit tests: Linux 260 passed/3 platform skips, Windows 224/39, and each Mac architecture 231/32; no failures. All 24 regular desktop reports passed with no renderer errors, including 12 navigation checks per platform. Linux restoration is separately `passed-with-limitations`, as described above.

**Performance:** [formal four-platform run 36292683561](https://github.com/asoming/diskharbor/actions/runs/36292683561), source `12edec9d834af9951efe18856c1ba377c2dd37c7`, passed the unchanged budgets: sort completion p95 ≤200ms, cancellation feedback ≤1s/observed local settlement ≤3s, and million-record whole-app peak ≤1.5 GiB. This measures the alpha.12 runtime, not alpha.13.

| Platform | Sort p95 / maximum | Cancellation feedback | 1M whole-app peak | Result |
| --- | ---: | ---: | ---: | --- |
| Linux x64 | 66.7 / 98.7ms | 27.9ms | 1.2699 GiB | Passed |
| Windows x64 | 63.2 / 93.0ms | 25.6ms | 1.0650 GiB | Passed |
| macOS Intel | 166.2 / 199.3ms | 53.7ms | 1.1769 GiB | Passed |
| macOS ARM64 | 101.7 / 236.3ms | 578.1ms | 1.3407 GiB | Passed |

All four runners scanned 100,129 real files, including 100,000 empty siblings and depth 82, and retained 1,000,000 complete synthetic records. All seven functional checks passed. All 240 fixed sort samples were retained, each with exactly one production query; p95 uses nearest rank after stable DOM/frame completion. Both actual viewport setups and Chinese/English 200% keyboard interaction passed with visible focus on every platform.

Passing p95 is not a guarantee that every interaction is under 200ms: ARM retained one **236.3ms** sort and **578.1ms** cancellation feedback. Earlier failures remain evidence: [alpha.11 run 36252607354](https://github.com/asoming/diskharbor/actions/runs/36252607354) recorded Intel sort p95 265.9ms and ARM cancellation feedback **2,309ms**; the earlier multi-second ARM frame delay still has no established cause. [Run 36291720088](https://github.com/asoming/diskharbor/actions/runs/36291720088) retained Intel p95 231.5ms before the viewport-layout fix. [Run 36292439794](https://github.com/asoming/diskharbor/actions/runs/36292439794) could not start Intel's application because Electron download failed; it has no Intel performance measurements. These records are not deleted or relabeled as passed.

These are warm-cache metadata measurements on recorded CI hardware, not a controlled 4-core/8-GiB reference machine or cold-disk throughput claim. Memory sums process working sets at 100ms intervals during scan/memory phases, conservatively double-counting shared pages; synchronous sampling is paused during timed interactions. All raw samples are retained, and diagnostic/trace modes were off. Manual screen-reader listening remains unverified.

The alpha.12 local Linux/X11 measurement recorded sort p95 **67.6ms** and million-record whole-app peak **1.4347 GiB**, leaving about 67 MiB below the memory budget. The 200ms target concerns the real-100k interface workload, not every million-record query; the million-record phase verifies complete retention and whole-application memory.

**Installation, upgrade and browser validation:** [four-platform run 36293120322](https://github.com/asoming/diskharbor/actions/runs/36293120322), source `abe3ee40ad46472dd95031ecf07eb3b82eaa4857`. All four jobs passed five package checks and four browser checks. The upgrade baseline is the actual published alpha.11 source (`41eab5d9a2c2ddadd5ff71739df63a3197139024`). Packages were installed on disposable runners, upgraded from that baseline, launched with the renderer sandbox, checked for the custom icon and fixture preference/history preservation, then uninstalled. Linux uses a DEB; Windows uses a current-user NSIS installer; macOS copies and replaces an app bundle from a read-only DMG. The Mac check is not Gatekeeper approval or a pkg-installer test.

The validation hosts were Ubuntu 24.04.5 x64, Windows Server 2025 (10.0.26100) x64, macOS 26.6.2 ARM64 and macOS 15.7.9 Intel. These runners do not establish Windows 10/11 desktop or older macOS compatibility.

Firefox **156.0.1** used isolated profiles in its actual standard profile/cache layout on all four runners. Cached resources survived restart; native cache-only clearing caused a fresh request while cookie, localStorage, bookmark and profile-file sentinels remained. Clearing used `nsIClearDataService.CLEAR_NETWORK_CACHE` through privileged loopback WebDriver, not the settings GUI. The application itself provides manual guidance and does not run that service.

The earlier Linux Chrome **152.0.7977.82** experiment used custom profile/cache directories and preserved cookie/localStorage/IndexedDB sentinels after native cache-only clearing. It does not validate default Chrome paths, Chromium, bookmarks or passwords.

## Remaining limits

- Real cloud-provider hydration, macOS TCC dialogs, physical removable-drive disconnection and manual assistive-technology use still need field validation. Simulated failures are not real unplug tests.
- Allocated totals exclude directory metadata, reserved space and snapshot accounting. Unknown allocations can make known-byte summaries incomplete; APFS shared extents are not deduplicated. Sparse/compressed metadata checks are not universal filesystem certification.
- No automatic cache cleanup, duplicate-file finder, scan snapshots, document rendering, dark mode or automatic restoration is provided.
- No signed/notarized stable distribution is available. Package tests on disposable runners do not establish every installer, OS version or enterprise policy combination.

## License

Current source is available under the [MIT License](LICENSE). Third-party components retain their own copyright and license notices.
