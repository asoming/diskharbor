# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md) · [GitHub](https://github.com/asoming/diskharbor)

DiskHarbor is a local desktop disk space analyzer. Explore what occupies your storage, inspect files and folders, and review the exact files before moving them to the system Trash.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

**0.1.0-alpha.1 — an early Linux alpha.** The Electron 44 application runs on the Ubuntu 22.04 x86_64 development environment, with renderer sandboxing enabled and production assets served through its application protocol. Windows and macOS native operation, packaging, compatibility, and signing remain unverified.

The first stable release targets the same core workflows on Linux, Windows, and macOS. This alpha does not establish that cross-platform support.

## Available functionality

- **Storage overview:** real scan results grouped by category, with allocated space and logical file size shown separately.
- **File explorer:** an expandable file tree with lazy loading, pagination, virtualized rows, keyboard navigation, sorting, search, and size/category filters.
- **File details:** inspect metadata and paths, reveal an item in the system file manager, and copy its path.
- **Reviewed cleanup:** select regular files, inspect the cleanup plan, and confirm through a native dialog before moving eligible files to the system Trash. File identity is checked again before the operation; a failed trash operation does not fall back to permanent deletion.
- **Result history:** local records of individual outcomes and the observed change in volume free space. Moving a file to the same volume's Trash usually does not immediately free space.
- **Local, bilingual use:** Chinese and English interfaces without an account or uploading scanned filenames, paths, or file contents.

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
```

Current validation on the Linux development machine:

- React/TypeScript production build passes.
- 30 unit scenarios pass: 17 scanner tests and 13 cleanup tests.
- Application UI checks with 141 synthetic files passed scanning, tree expansion, search, keyboard pagination, virtual scrolling, Chinese/English switching, cleanup-plan preview, and modal focus checks.
- A real native Trash integration check passed cancellation, identity-change protection, Trash content verification, and local history persistence, using isolated synthetic data.

These results do not certify other operating systems, every filesystem, accessibility conformance, or whole-disk performance.

Linux `.deb` and `.tar.gz` packages build successfully. The packaged application has been launched and scanned test files on Ubuntu 22.04 x64. System-wide installation and clean-machine testing are still pending. Build outputs are written to `release/`.

```bash
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

- Application-cache automatic cleanup, directory cleanup, duplicate-file detection, and scan snapshots are not implemented.
- File details show metadata; full content preview, dark mode, complete error-message translation, and an in-app recovery interface are not available.
- Allocated size excludes directory metadata; APFS shared extents and cloud-placeholder states are not identified. A native Trash call uses a path, so revalidation cannot eliminate every filesystem race. Activity is saved after each batch; crash recovery during a batch is not guaranteed.
- Windows/macOS native validation and signing are pending. Passing Linux unit tests does not establish support on those platforms.

## License

A project license has not been selected. The package is marked `UNLICENSED`; this repository does not currently grant an open-source license.
