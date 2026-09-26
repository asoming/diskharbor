# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor is a local desktop disk space analyzer. Explore what occupies your storage, inspect files and folders, and review selected items before moving them to the system Trash.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

**0.1.0-alpha.2 — an early Linux alpha.** The Electron 44 application runs on the Ubuntu 22.04 x86_64 development environment, with renderer sandboxing enabled and production assets served through its application protocol. Windows and macOS native operation, packaging, compatibility, and signing remain unverified.

The first stable release targets the same core workflows on Linux, Windows, and macOS. This alpha does not establish that cross-platform support.

## Available functionality

- **Storage overview:** real scan results grouped by category, with allocated space and logical file size shown separately.
- **File explorer:** an expandable file tree with lazy loading, pagination, virtualized rows, keyboard navigation, sorting, search, and size/category filters.
- **File details:** inspect metadata and paths, reveal an item in the system file manager, and copy its path.
- **Reviewed file and folder cleanup:** select ordinary files or eligible directories, inspect the plan, and confirm through a native dialog. A directory is moved as one native Trash item only after its complete indexed contents pass metadata checks and match the current filesystem. A blocked directory is not partially cleaned, and a failed Trash operation never falls back to permanent deletion.
- **Progress and cancellation:** see individual operation results and stop operations that have not started. An in-flight native Trash call may finish; cancellation does not undo completed moves.
- **System Trash access:** open the system Trash and follow the platform's manual restoration instructions. DiskHarbor does not restore files automatically or empty the Trash. Restoration depends on the item still being available and the system's capabilities.
- **Durable local history:** save checkpoints before native operations and after individual results, retaining up to 50 operation records. Interrupted work is not automatically resumed; pending items become cancelled and items last recorded as processing become uncertain results. File absence is never treated as proof of a successful move.
- **Space verification:** record the observed change in volume free space separately from Trash results. Moving an item to the same volume's Trash usually does not immediately free space.
- **Local, bilingual use:** Chinese and English interfaces without an account or uploading scanned filenames, paths, or file contents.

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

Current validation on the Linux development machine:

- React/TypeScript production build passes.
- Unit checks cover scanning, cleanup eligibility, directory validation, cancellation, journal recovery, atomic write failures, and system Trash entry points. Windows/macOS entry-point checks use mocks and do not establish native support.
- Application UI checks cover scanning, tree expansion, search, keyboard pagination, virtual scrolling, Chinese/English switching, cleanup-plan preview, and modal focus handling with synthetic files.
- Native Electron integration checks passed directory moves to Trash, parent/child selection normalization, changed-directory rejection, cancellation that preserves unstarted items, local journal persistence, and conservative interruption recovery.

These results do not certify other operating systems, every filesystem, accessibility conformance, or whole-disk performance.

Desktop integration CI is configured for Linux, Windows, and macOS. The newly added three-platform workflow has not yet completed validation; native results for Windows and macOS are still pending.

Linux package targets are `.deb` and `.tar.gz`. System-wide installation and clean-machine testing remain pending. Build outputs are separated by version under `release/${version}/`, currently `release/0.1.0-alpha.2/`.

```bash
# Unpacked application
npm run pack

# Linux packages
npm run dist:linux
```

Windows and macOS build commands are also defined, but need native verification and signing on their respective platforms:

```bash
# On Windows
npm run dist:win

# On macOS
npm run dist:mac
```

## Current limitations

- Application-cache automatic cleanup, duplicate-file detection, and scan snapshots are not implemented.
- File details show metadata; full content preview, dark mode, and automatic in-app restoration are not available. System error text may remain in the operating system's language.
- Allocated size excludes directory metadata; APFS shared extents and cloud-placeholder states are not identified. A native Trash call uses a path, so revalidation cannot eliminate every filesystem race. Journaling preserves checkpoints, but a crash between a native operation and its result checkpoint leaves an uncertain outcome requiring manual inspection.
- The **35 MB package-size target is not met** by this Electron alpha. Check the generated artifacts for their actual sizes; no smaller package size is promised.
- Windows/macOS native validation and signing are pending. Passing Linux unit tests does not establish support on those platforms.

## License

A project license has not been selected. The package is marked `UNLICENSED`; this repository does not currently grant an open-source license.
