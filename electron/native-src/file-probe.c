/* A persistent, metadata-only probe and bounded explicit reader.
 * stdin: id<TAB>M<TAB>hex(UTF-8 absolute path)
 *        id<TAB>R<TAB>hex(path)<TAB>limit<TAB>dev<TAB>ino<TAB>size<TAB>nlink
 *          <TAB>mtimeNs<TAB>ctimeNs<TAB>parentDev<TAB>parentIno
 * stdout: one JSON result per request. Never accepts executable commands.
 * Metadata and content use no-follow handles. All ancestor handles remain open
 * until the response is complete; reads compare the opened object before AND
 * after reading. No data is returned on a failed post-read check. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#include <errno.h>
#include "file-policy.h"

#define DH_MAX_PATH 131072
#define DH_MAX_LINE (DH_MAX_PATH * 2 + 2048)
#define DH_MAX_BYTES (8 * 1024 * 1024)
#define DH_MAX_DEPTH 512

typedef struct {
  char dev[32], ino[32], size[32], nlink[32], mtime[32], ctime[32];
  char parent_dev[32], parent_ino[32];
  char filesystem[64], mount[DH_MAX_PATH];
  const char *kind;
  int hidden, system, reparse, cloud, local;
} dh_info;

static void dh_number(char *target, uint64_t value) { snprintf(target, 32, "%" PRIu64, value); }
static void dh_signed(char *target, int64_t value) { snprintf(target, 32, "%" PRId64, value); }
static void dh_json_string(const char *text) {
  const unsigned char *p = (const unsigned char *)text;
  putchar('"');
  for (; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static void dh_error(unsigned id, const char *code) {
  printf("{\"id\":%u,\"error\":", id); dh_json_string(code); puts("}"); fflush(stdout);
}
static void dh_base64(const unsigned char *data, size_t count) {
  static const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t i;
  putchar('"');
  for (i = 0; i < count; i += 3) {
    unsigned value = (unsigned)data[i] << 16;
    if (i + 1 < count) value |= (unsigned)data[i + 1] << 8;
    if (i + 2 < count) value |= data[i + 2];
    putchar(chars[(value >> 18) & 63]); putchar(chars[(value >> 12) & 63]);
    putchar(i + 1 < count ? chars[(value >> 6) & 63] : '=');
    putchar(i + 2 < count ? chars[value & 63] : '=');
  }
  putchar('"');
}
static void dh_result(unsigned id, const dh_info *info, const unsigned char *bytes, size_t count, int read) {
  printf("{\"id\":%u,\"metadata\":{\"kind\":", id); dh_json_string(info->kind);
  printf(",\"hidden\":%s,\"system\":%s,\"reparsePoint\":%s,\"cloudState\":",
    info->hidden ? "true" : "false", info->system ? "true" : "false", info->reparse ? "true" : "false");
  dh_json_string(info->cloud == 1 ? "placeholder" : info->cloud == 2 ? "unknown" : "resident");
  printf(",\"volume\":{\"local\":%s,\"filesystem\":", info->local ? "true" : "false"); dh_json_string(info->filesystem);
  printf(",\"mountPath\":"); if (*info->mount) dh_json_string(info->mount); else printf("null");
  printf("},\"identity\":{\"dev\":"); dh_json_string(info->dev);
  printf(",\"ino\":"); dh_json_string(info->ino);
  printf(",\"size\":"); dh_json_string(info->size);
  printf(",\"nlink\":"); dh_json_string(info->nlink);
  printf(",\"mtimeNs\":"); dh_json_string(info->mtime);
  printf(",\"ctimeNs\":"); dh_json_string(info->ctime);
  printf(",\"parentDev\":"); dh_json_string(info->parent_dev);
  printf(",\"parentIno\":"); dh_json_string(info->parent_ino);
  printf("}}");
  if (read) { printf(",\"bytes\":"); dh_base64(bytes, count); }
  puts("}"); fflush(stdout);
}
static int dh_match(const dh_info *info, char **expected) {
  return !strcmp(info->dev, expected[0]) && !strcmp(info->ino, expected[1]) &&
    !strcmp(info->size, expected[2]) && !strcmp(info->nlink, expected[3]) &&
    !strcmp(info->mtime, expected[4]) && !strcmp(info->ctime, expected[5]) &&
    !strcmp(info->parent_dev, expected[6]) && !strcmp(info->parent_ino, expected[7]);
}
static int dh_hex(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}
static int dh_decode_path(char *hex, char *result) {
  size_t length = strlen(hex), i;
  if (!length || length % 2 || length / 2 >= DH_MAX_PATH) return 0;
  for (i = 0; i < length; i += 2) {
    int a = dh_hex(hex[i]), b = dh_hex(hex[i + 1]);
    if (a < 0 || b < 0 || !(a || b)) return 0;
    result[i / 2] = (char)((a << 4) | b);
  }
  result[length / 2] = 0;
  return 1;
}

#ifdef _WIN32
#include <winioctl.h>
#include <wchar.h>
#ifndef FILE_ATTRIBUTE_RECALL_ON_OPEN
#define FILE_ATTRIBUTE_RECALL_ON_OPEN 0x00040000
#endif
#ifndef FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
#define FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS 0x00400000
#endif
#define DH_CLOUD_TAG(tag) (((tag) & 0xffff0fffUL) == 0x9000001aUL)

static const char *dh_os_error(void) {
  DWORD code = GetLastError();
  if (code == ERROR_ACCESS_DENIED || code == ERROR_SHARING_VIOLATION) return "PERMISSION_DENIED";
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return "MISSING_FILE";
  return "NATIVE_METADATA_UNAVAILABLE";
}
static int dh_safe_attributes(const dh_info *info) {
  return !info->reparse && info->cloud == 0;
}
static int dh_utf8(const wchar_t *input, char *output, int capacity) {
  return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input, -1, output, capacity, NULL, NULL) > 0;
}
static int dh_information(HANDLE handle, dh_info *info) {
  BY_HANDLE_FILE_INFORMATION stat;
  FILE_BASIC_INFO basic;
  FILE_ATTRIBUTE_TAG_INFO tag;
  wchar_t fsname[64], final_path[32768];
  DWORD attrs, final_length;
  if (!GetFileInformationByHandle(handle, &stat) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof basic) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof tag)) return 0;
  attrs = stat.dwFileAttributes;
  dh_number(info->dev, stat.dwVolumeSerialNumber);
  dh_number(info->ino, ((uint64_t)stat.nFileIndexHigh << 32) | stat.nFileIndexLow);
  dh_number(info->size, ((uint64_t)stat.nFileSizeHigh << 32) | stat.nFileSizeLow);
  dh_number(info->nlink, stat.nNumberOfLinks);
  /* Node/libuv uses NTFS ChangeTime (not CreationTime) for ctime. Append the
   * two decimal zeros instead of overflowing int64 for pre-1677/future dates. */
  if (basic.LastWriteTime.QuadPart < INT64_MIN + INT64_C(116444736000000000) ||
      basic.ChangeTime.QuadPart < INT64_MIN + INT64_C(116444736000000000)) return 0;
  {
    int64_t mtime = basic.LastWriteTime.QuadPart - INT64_C(116444736000000000);
    int64_t ctime = basic.ChangeTime.QuadPart - INT64_C(116444736000000000);
    if (mtime) snprintf(info->mtime, 32, "%" PRId64 "00", mtime); else strcpy(info->mtime, "0");
    if (ctime) snprintf(info->ctime, 32, "%" PRId64 "00", ctime); else strcpy(info->ctime, "0");
  }
  info->kind = attrs & FILE_ATTRIBUTE_DIRECTORY ? "directory" : "file";
  info->hidden = !!(attrs & FILE_ATTRIBUTE_HIDDEN);
  info->system = !!(attrs & FILE_ATTRIBUTE_SYSTEM);
  info->reparse = !!(attrs & FILE_ATTRIBUTE_REPARSE_POINT);
  if (info->reparse && (tag.ReparseTag == IO_REPARSE_TAG_SYMLINK || tag.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT)) info->kind = "symlink";
  info->cloud = attrs & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) || DH_CLOUD_TAG(tag.ReparseTag) ? 1 : info->reparse ? 2 : 0;
  info->local = 0;
  if (GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, NULL, fsname, 64)) dh_utf8(fsname, info->filesystem, sizeof info->filesystem);
  /* A DOS final path identifies its drive without following a renderer-provided
   * volume path. Remote UNC paths and unrecognized types stay unverified. */
  final_length = GetFinalPathNameByHandleW(handle, final_path, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (final_length >= 7 && final_length < 32768 && !wcsncmp(final_path, L"\\\\?\\", 4) && final_path[5] == L':') {
    wchar_t drive[4] = { final_path[4], L':', L'\\', 0 };
    UINT type = GetDriveTypeW(drive);
    dh_utf8(drive, info->mount, sizeof info->mount);
    info->local = (type == DRIVE_FIXED || type == DRIVE_REMOVABLE) &&
      (!_stricmp(info->filesystem, "NTFS") || !_stricmp(info->filesystem, "ReFS") ||
       !_stricmp(info->filesystem, "exFAT") || !_stricmp(info->filesystem, "FAT32") || !_stricmp(info->filesystem, "FAT"));
  }
  return 1;
}
static void dh_probe(unsigned id, const char *input, int read, size_t limit, char **expected) {
  wchar_t full[32768], prefix[32768];
  HANDLE handles[DH_MAX_DEPTH];
  int count = 0, length, start, cursor;
  dh_info info, parent, after;
  unsigned char *bytes = NULL;
  const char *error = NULL;
  memset(&info, 0, sizeof info); memset(&parent, 0, sizeof parent);
  length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, full, 32768);
  if (!length || length < 4 || !((full[0] >= L'A' && full[0] <= L'Z') || (full[0] >= L'a' && full[0] <= L'z')) || full[1] != L':' || (full[2] != L'\\' && full[2] != L'/')) { dh_error(id, "UNSUPPORTED_PATH"); return; }
  length--;
  if (length > 32763) { dh_error(id, "UNSUPPORTED_PATH"); return; }
  for (cursor = 2; cursor < length; cursor++) if (full[cursor] == L'/') full[cursor] = L'\\';
  if (length > 3 && full[length - 1] == L'\\') { dh_error(id, "UNSUPPORTED_PATH"); return; }
  memcpy(prefix, L"\\\\?\\", 4 * sizeof(wchar_t));
  memcpy(prefix + 4, full, 3 * sizeof(wchar_t)); prefix[7] = 0;
  cursor = 3; start = 3;
  for (;;) {
    int final = cursor == length;
    HANDLE handle;
    DWORD access = FILE_READ_ATTRIBUTES;
    if (cursor > 3) {
      int component_length = cursor - start;
      if (component_length <= 0 || full[cursor - 1] == L'.' || full[cursor - 1] == L' ') { error = "UNSUPPORTED_PATH"; break; }
      memcpy(prefix + 4, full, cursor * sizeof(wchar_t)); prefix[cursor + 4] = 0;
    }
    if (count >= DH_MAX_DEPTH) { error = "UNSUPPORTED_PATH"; break; }
    handle = CreateFileW(prefix, access, read ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL | FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (handle == INVALID_HANDLE_VALUE) { error = dh_os_error(); break; }
    handles[count++] = handle;
    parent = info;
    memset(&info, 0, sizeof info);
    if (!dh_information(handle, &info)) { error = dh_os_error(); break; }
    if (count == 1) parent = info;
    strcpy(info.parent_dev, parent.dev); strcpy(info.parent_ino, parent.ino);
    if ((!final || read) && !dh_safe_attributes(&info)) { error = info.cloud == 1 ? "CLOUD_PLACEHOLDER" : "SYMLINK_PARENT"; break; }
    /* A volume root's intrinsic HIDDEN/SYSTEM attributes describe the volume
     * object, not every descendant. The root remains metadata-only; all actual
     * path components and the final file retain these protections. */
    if (read && count > 1 && (info.hidden || info.system)) { error = info.hidden ? "HIDDEN_PATH" : "SYSTEM_PATH"; break; }
    if (!final && strcmp(info.kind, "directory")) { error = "PARENT_CHANGED"; break; }
    if (final) break;
    start = cursor;
    if (start > 3) start++;
    cursor = start;
    while (cursor < length && full[cursor] != L'\\') {
      if (full[cursor] == L':' || full[cursor] < 32) { error = "UNSUPPORTED_PATH"; break; }
      cursor++;
    }
    if (error) break;
  }
  if (!error && read) {
    size_t used = 0;
    if (strcmp(info.kind, "file")) error = "NOT_REGULAR_FILE";
    else if (!info.local) error = "PREVIEW_VOLUME_UNVERIFIED";
    else if (strcmp(info.nlink, "1")) error = "SHARED_FILE";
    else if (!dh_match(&info, expected)) error = "IDENTITY_CHANGED";
    if (!error) {
      HANDLE reader;
      /* The metadata handle holds the object against delete/write sharing.
       * Only a verified resident regular file is reopened for data access. */
      reader = CreateFileW(prefix, GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL, NULL);
      if (reader == INVALID_HANDLE_VALUE) error = dh_os_error();
      else if (count >= DH_MAX_DEPTH) { CloseHandle(reader); error = "UNSUPPORTED_PATH"; }
      else {
        handles[count++] = reader;
        memset(&after, 0, sizeof after);
        if (!dh_information(reader, &after)) error = "NATIVE_METADATA_UNAVAILABLE";
        else {
          strcpy(after.parent_dev, info.parent_dev); strcpy(after.parent_ino, info.parent_ino);
          if (!dh_match(&after, expected) || !dh_safe_attributes(&after) || after.hidden || after.system || !after.local) error = "IDENTITY_CHANGED";
        }
      }
    }
    if (!error) {
      bytes = (unsigned char *)malloc(limit ? limit : 1);
      if (!bytes) error = "NATIVE_METADATA_UNAVAILABLE";
    }
    while (!error && used < limit) {
      DWORD got = 0;
      if (!ReadFile(handles[count - 1], bytes + used, (DWORD)(limit - used), &got, NULL)) error = "UNREADABLE_FILE";
      else if (!got) error = "IDENTITY_CHANGED";
      else used += got;
    }
    if (!error) {
      memset(&after, 0, sizeof after);
      if (!dh_information(handles[count - 1], &after)) error = "NATIVE_METADATA_UNAVAILABLE";
      else {
        strcpy(after.parent_dev, info.parent_dev); strcpy(after.parent_ino, info.parent_ino);
        if (!dh_match(&after, expected) || !dh_safe_attributes(&after) || after.hidden || after.system || !after.local || strcmp(after.filesystem, info.filesystem)) error = "IDENTITY_CHANGED";
      }
    }
  }
  /* Publish completion only after releasing sharing locks. A caller may act on
   * its own file immediately after receiving the response. */
  while (count) CloseHandle(handles[--count]);
  if (error) dh_error(id, error); else dh_result(id, &info, bytes, limit, read);
  free(bytes);
}
#elif defined(__APPLE__)
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>

static const char *dh_os_error(void) {
  if (errno == EDEADLK) return "CLOUD_PLACEHOLDER";
  if (errno == ELOOP) return "SYMLINK_PARENT";
  if (errno == ENOENT || errno == ENOTDIR) return "MISSING_FILE";
  if (errno == EACCES || errno == EPERM) return "PERMISSION_DENIED";
  return "NATIVE_METADATA_UNAVAILABLE";
}
static void dh_stat_info(const struct stat *stat, dh_info *info) {
  dh_number(info->dev, (uint64_t)stat->st_dev); dh_number(info->ino, (uint64_t)stat->st_ino);
  dh_number(info->size, (uint64_t)stat->st_size); dh_number(info->nlink, (uint64_t)stat->st_nlink);
  dh_signed(info->mtime, (int64_t)stat->st_mtimespec.tv_sec * INT64_C(1000000000) + stat->st_mtimespec.tv_nsec);
  dh_signed(info->ctime, (int64_t)stat->st_ctimespec.tv_sec * INT64_C(1000000000) + stat->st_ctimespec.tv_nsec);
  info->kind = S_ISDIR(stat->st_mode) ? "directory" : S_ISREG(stat->st_mode) ? "file" : S_ISLNK(stat->st_mode) ? "symlink" : "other";
  info->hidden = !!(stat->st_flags & UF_HIDDEN);
#ifdef SF_RESTRICTED
  info->system = !!(stat->st_flags & SF_RESTRICTED);
#endif
  info->reparse = S_ISLNK(stat->st_mode);
  info->cloud = stat->st_flags & SF_DATALESS ? 1 : 0;
}
static void dh_volume(int fd, dh_info *info) {
  struct statfs volume;
  if (fstatfs(fd, &volume)) return;
  snprintf(info->filesystem, sizeof info->filesystem, "%s", volume.f_fstypename);
  snprintf(info->mount, sizeof info->mount, "%s", volume.f_mntonname);
  info->local = !!(volume.f_flags & MNT_LOCAL) &&
    (!strcmp(volume.f_fstypename, "apfs") || !strcmp(volume.f_fstypename, "hfs") ||
     !strcmp(volume.f_fstypename, "exfat") || !strcmp(volume.f_fstypename, "msdos"));
}
static void dh_probe(unsigned id, const char *input, int read, size_t limit, char **expected) {
  int handles[DH_MAX_DEPTH], count = 0, fd = -1;
  char *parts = NULL, *component, *next;
  dh_info info, after;
  struct stat stat, parent;
  unsigned char *bytes = NULL;
  const char *error = NULL;
  memset(&info, 0, sizeof info);
  if (input[0] != '/' || (strlen(input) > 1 && input[strlen(input) - 1] == '/')) { dh_error(id, "UNSUPPORTED_PATH"); return; }
  parts = strdup(input + 1);
  if (!parts) { dh_error(id, "NATIVE_METADATA_UNAVAILABLE"); return; }
  fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) { error = dh_os_error(); goto done; }
  handles[count++] = fd;
  if (fstat(fd, &parent)) { error = dh_os_error(); goto done; }
  stat = parent;
  component = parts;
  while (*component) {
    int final;
    next = strchr(component, '/');
    if (next) *next = 0;
    final = !next;
    if (!*component || !strcmp(component, ".") || !strcmp(component, "..") || count >= DH_MAX_DEPTH) { error = "UNSUPPORTED_PATH"; goto done; }
    if (fstat(fd, &parent)) { error = dh_os_error(); goto done; }
    if (fstatat(fd, component, &stat, AT_SYMLINK_NOFOLLOW)) { error = dh_os_error(); goto done; }
    dh_stat_info(&stat, &info);
    if (read && (info.hidden || info.system)) { error = info.hidden ? "HIDDEN_PATH" : "SYSTEM_PATH"; goto done; }
    if ((!final || read) && info.cloud) { error = "CLOUD_PLACEHOLDER"; goto done; }
    if ((!final || read) && info.reparse) { error = "SYMLINK_PARENT"; goto done; }
    if (!final && !S_ISDIR(stat.st_mode)) { error = "PARENT_CHANGED"; goto done; }
    if (final && (info.reparse || info.cloud)) break;
    if (fstat(fd, &parent)) { error = dh_os_error(); goto done; }
    fd = openat(fd, component, (read && final ? O_RDONLY : O_EVTONLY) | O_NOFOLLOW | O_NONBLOCK | (!final ? O_DIRECTORY : 0));
    if (fd < 0) { error = dh_os_error(); goto done; }
    handles[count++] = fd;
    if (fstat(fd, &stat)) { error = dh_os_error(); goto done; }
    dh_stat_info(&stat, &info);
    if ((!final || read) && (info.cloud || info.reparse)) { error = info.cloud ? "CLOUD_PLACEHOLDER" : "SYMLINK_PARENT"; goto done; }
    if (final) break;
    component = next + 1;
  }
  dh_stat_info(&stat, &info);
  dh_number(info.parent_dev, (uint64_t)parent.st_dev); dh_number(info.parent_ino, (uint64_t)parent.st_ino);
  dh_volume(fd, &info);
  if (read) {
    size_t used = 0;
    if (info.hidden || info.system) { error = info.hidden ? "HIDDEN_PATH" : "SYSTEM_PATH"; goto done; }
    if (!S_ISREG(stat.st_mode)) { error = "NOT_REGULAR_FILE"; goto done; }
    if (!info.local) { error = "PREVIEW_VOLUME_UNVERIFIED"; goto done; }
    if (stat.st_nlink != 1) { error = "SHARED_FILE"; goto done; }
    if (!dh_match(&info, expected)) { error = "IDENTITY_CHANGED"; goto done; }
    bytes = (unsigned char *)malloc(limit ? limit : 1);
    if (!bytes) { error = "NATIVE_METADATA_UNAVAILABLE"; goto done; }
    while (used < limit) {
      ssize_t got = pread(fd, bytes + used, limit - used, (off_t)used);
      if (got < 0 && errno == EINTR) continue;
      if (got < 0) { error = dh_os_error(); goto done; }
      if (!got) { error = "IDENTITY_CHANGED"; goto done; }
      used += (size_t)got;
    }
    memset(&after, 0, sizeof after);
    if (fstat(fd, &stat)) { error = dh_os_error(); goto done; }
    dh_stat_info(&stat, &after); dh_volume(fd, &after);
    strcpy(after.parent_dev, info.parent_dev); strcpy(after.parent_ino, info.parent_ino);
    if (!dh_match(&after, expected) || after.cloud || after.reparse || after.hidden || after.system || !after.local || strcmp(after.filesystem, info.filesystem)) error = "IDENTITY_CHANGED";
  }
done:
  while (count) close(handles[--count]);
  if (error) dh_error(id, error); else dh_result(id, &info, bytes, limit, read);
  free(bytes); free(parts);
}
#else
static void dh_probe(unsigned id, const char *input, int read, size_t limit, char **expected) {
  (void)input; (void)read; (void)limit; (void)expected; dh_error(id, "NATIVE_METADATA_UNAVAILABLE");
}
#endif

int main(void) {
  char *line = (char *)malloc(DH_MAX_LINE), *file_path = (char *)malloc(DH_MAX_PATH);
  int policy = dh_install_policy();
  if (!line || !file_path) return 2;
  while (fgets(line, DH_MAX_LINE, stdin)) {
    char *fields[13], *cursor = line, *end;
    unsigned long id_value;
    unsigned id;
    int count = 0, read;
    size_t limit = 0, length = strlen(line);
    if (!length || line[length - 1] != '\n') { dh_error(0, "INVALID_NATIVE_REQUEST"); break; }
    line[--length] = 0;
    while (count < 13) {
      fields[count++] = cursor;
      cursor = strchr(cursor, '\t');
      if (!cursor) break;
      *cursor++ = 0;
    }
    id_value = strtoul(fields[0], &end, 10);
    if (*end || !id_value || id_value > 2147483647UL) { dh_error(0, "INVALID_NATIVE_REQUEST"); continue; }
    id = (unsigned)id_value;
    if (count < 3 || (strcmp(fields[1], "M") && strcmp(fields[1], "R")) || !dh_decode_path(fields[2], file_path)) { dh_error(id, "INVALID_NATIVE_REQUEST"); continue; }
    read = !strcmp(fields[1], "R");
    if (read) {
      unsigned long value;
      if (count != 12) { dh_error(id, "INVALID_NATIVE_REQUEST"); continue; }
      value = strtoul(fields[3], &end, 10);
      if (*end || value > DH_MAX_BYTES) { dh_error(id, "INVALID_NATIVE_REQUEST"); continue; }
      limit = (size_t)value;
    } else if (count != 3) { dh_error(id, "INVALID_NATIVE_REQUEST"); continue; }
    if (!policy) { dh_error(id, "NATIVE_POLICY_UNAVAILABLE"); continue; }
    dh_probe(id, file_path, read, limit, read ? fields + 4 : NULL);
  }
  free(line); free(file_path);
  return 0;
}
