# DiskHarbor

[English](README.md) · [简体中文](README.zh-CN.md)

DiskHarbor is a desktop disk space analyzer being developed for everyday users. It will help you understand what occupies your storage, explore a file tree, review cleanup suggestions, and verify the results of your actions.

**English name:** DiskHarbor · **Chinese name:** 盘清

## Status

The project is in the planning and design stage. There is no runnable application, installer, or release yet. The capabilities below are planned, not implemented.

## Planned capabilities

- **Storage overview:** see disk usage by category, folder, and file.
- **File tree:** expand folders, sort by size, search, filter, and inspect file details.
- **Cleanup suggestions:** understand each item's purpose, the basis for a suggestion, and the likely impact before choosing an action.
- **Reviewed operations:** confirm the selected files and use the system trash where supported; a failed trash operation will not silently become permanent deletion.
- **Result verification:** distinguish files moved to trash from space actually released, and report skipped or failed items.
- **Local use:** scan and browse without an account or uploading your filenames, paths, or file contents.
- **Chinese and English:** provide equivalent workflows in both interface languages.

## Platforms

The first stable release is planned for **Linux, Windows, and macOS**, with the same core workflows. Development starts on Linux; a Linux alpha may be available before the cross-platform stable release.

Permissions, file-system capabilities, and trash behavior will follow each platform's conventions. Platform support and performance will be documented after validation.

## Interface

A clear light interface with deep teal accents, readable storage categories, a dedicated file-tree page, and cleanup suggestions that explain their impact. Dark mode is planned as a later enhancement.

## Repository

Public documentation is limited to this README and its Chinese counterpart. Internal product requirements and design materials are maintained locally and are excluded from Git.

Build, run, and installation instructions will be added here when an implementation is available and verified. A project license has not been selected yet.
