# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor is a local desktop disk space analyzer. Explore what occupies your storage, inspect files and folders, and review selected items before moving them to the system Trash.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

**0.1.0-alpha.3 — an early desktop alpha.** This version adds explicit content previews on verified local Linux filesystems and a Chinese name for the Linux application launcher. Three-platform CI passes, including production builds and basic native scanning/cleanup checks, with renderer sandboxing enabled and production assets served through the application protocol. Windows/macOS content preview is not enabled; tests verify that these platforms correctly refuse preview requests. Clean-machine installation, signed Windows/macOS packages, and complete platform compatibility remain pending.

The first stable release targets the same core workflows on Linux, Windows, and macOS. These alpha checks cover the tested workflows, not complete platform support.

## Available functionality

- **Storage overview:** real scan results grouped by category, with allocated space and logical file size shown separately.
- **File explorer:** an expandable file tree with lazy loading, pagination, virtualized rows, keyboard navigation, sorting, search, and size/category filters.
- **File details:** inspect metadata and paths, reveal an item in the system file manager, and copy its path.
- **On-demand content preview:** explicitly preview supported UTF-8 text and PNG, JPEG, or WebP images on verified local Linux filesystems. Inspecting an item does not automatically read its contents.
- **Reviewed file and folder cleanup:** select ordinary files or eligible directories, inspect the plan, and confirm through a native dialog. A directory is moved as one native Trash item only after its complete indexed contents pass metadata checks and match the current filesystem. A blocked directory is not partially cleaned, and a failed Trash operation never falls back to permanent deletion.
- **Progress and cancellation:** see individual operation results and stop operations that have not started. An in-flight native Trash call may finish; cancellation does not undo completed moves.
- **System Trash access:** open the system Trash and follow the platform's manual restoration instructions. DiskHarbor does not restore files automatically or empty the Trash. Restoration depends on the item still being available and the system's capabilities.
- **Durable local history:** save checkpoints before native operations and after individual results, retaining up to 50 operation records. Interrupted work is not automatically resumed; pending items become cancelled and items last recorded as processing become uncertain results. File absence is never treated as proof of a successful move.
- **Space verification:** record the observed change in volume free space separately from Trash results. Moving an item to the same volume's Trash usually does not immediately free space.
- **Local, bilingual use:** Chinese and English interfaces without an account or uploading scanned filenames, paths, or file contents.
- **Linux application launcher:** the desktop entry supports the Chinese name **盘清** as well as **DiskHarbor**.

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
```

On Linux, the desktop integration test needs a graphical session with `DISPLAY`, or Xvfb:

```bash
xvfb-run -a npm run test:desktop
```

Build the production interface before running `test:desktop`. The test uses isolated synthetic data and a separate application profile; it exercises native Trash operations without scanning personal folders.

The **alpha.3** [three-platform CI run](https://github.com/asoming/diskharbor/actions/runs/36230216827) passed for commit [`6cb5c2b`](https://github.com/asoming/diskharbor/commit/6cb5c2b0bee4f7c1e1497346e4c99b96fc43add2). All platforms had **0 failed unit checks**; each native desktop report records `result: passed` and `errors: []`:

| Platform | Unit checks passed | Skipped | Production build | Native Electron checks passed |
| --- | ---: | ---: | --- | --- |
| Ubuntu | 88 | 0 | Passed | 16 |
| Windows | 59 | 29 | Passed | 14 |
| macOS | 65 | 23 | Passed | 14 |

Skipped checks are not counted as passes. Windows/macOS each skip 19 Linux-only preview checks in addition to their existing platform exclusions; their refusal-path checks pass. These results do not mean that content preview is enabled on Windows/macOS. Current coverage includes:

- React/TypeScript production build passes.
- Unit checks cover scanning, cleanup eligibility, directory validation, cancellation, journal recovery, atomic write failures, and system Trash entry points. Opening the system Trash on Windows/macOS is still tested with mocks; those entry points have not been verified natively.
- Linux application UI checks cover scanning, tree expansion, search, keyboard pagination, virtual scrolling, Chinese/English switching, cleanup-plan preview, and modal focus handling with synthetic files.
- Native Electron checks on all three platforms passed basic scanning, real directory moves to Trash, parent/child selection normalization, changed-directory rejection, live progress across page navigation, UI cancellation that preserves unstarted items, local journal persistence, and conservative interruption recovery. Full manual restoration has not been tested.
- Linux native preview checks passed stale-scan rejection, real UTF-8/PNG reads, literal HTML display, opt-in reads, image loading, focus restoration, and unchanged cleanup history. Windows/macOS native checks passed explicit preview refusal and its UI explanation while retaining the scanning/cleanup checks.

These results do not certify every operating-system version or filesystem, accessibility conformance, or whole-disk performance.

Linux `.deb` and `.tar.gz` packages have been built locally for alpha.3: **96.8 MiB** (101,469,064 bytes) and **117.1 MiB** (122,833,469 bytes), respectively. The packaged application was launched on Ubuntu 22.04.5 and passed actual GUI scanning, plain-text preview, and PNG decoding checks. Debian metadata and the localized desktop entry were inspected; SHA-256 checksums are saved alongside the local artifacts. The 35 MB target remains unmet. System-wide installation and clean-machine testing remain pending. Build outputs are separated by version under `release/${version}/`, currently `release/0.1.0-alpha.3/`; these artifacts have not been published as a GitHub Release.

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

- Application-cache automatic cleanup, duplicate-file detection, and scan snapshots are not implemented.
- Content preview is limited to the Linux filesystems and formats described above; Windows/macOS content preview, document rendering, dark mode, and automatic in-app restoration are not available. System error text may remain in the operating system's language.
- Allocated size excludes directory metadata. Windows allocated-space metadata and special-volume handling remain incomplete; entries without allocation metadata show unknown, while overview totals include only known allocation and may therefore undercount. APFS shared extents and cloud-placeholder states are not identified. A native Trash call uses a path, so revalidation cannot eliminate every filesystem race. Journaling preserves checkpoints, but a crash between a native operation and its result checkpoint leaves an uncertain outcome requiring manual inspection.
- The **35 MB package-size target is not met** by this Electron alpha. Check the generated artifacts for their actual sizes; no smaller package size is promised.
- Alpha.3 basic native scanning/cleanup checks pass on Windows/macOS, but content preview remains disabled. Signed packages and full compatibility remain pending. Their system Trash openers still have only mock coverage, and full manual restoration has not been tested.

## License

A project license has not been selected. The package is marked `UNLICENSED`; this repository does not currently grant an open-source license.
