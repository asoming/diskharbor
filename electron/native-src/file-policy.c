#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include "file-policy.h"
void dh_export_elevation(napi_env env, napi_value exports);
#ifdef __APPLE__
#include <sys/stat.h>
#endif

#ifdef _WIN32
static __declspec(thread) int policy_installed = 0;
#else
static _Thread_local int policy_installed = 0;
#endif

static napi_value install(napi_env env, napi_callback_info info) {
  napi_value result;
  (void)info;
  policy_installed = dh_install_policy() != 0;
  napi_get_boolean(env, policy_installed, &result);
  return result;
}

static void boolean_property(napi_env env, napi_value object, const char *key, int value) {
  napi_value result;
  napi_get_boolean(env, value != 0, &result);
  napi_set_named_property(env, object, key, result);
}

static void string_property(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value result;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  napi_set_named_property(env, object, key, result);
}

#ifdef _WIN32
static napi_value allocation_identity(napi_env env, const BY_HANDLE_FILE_INFORMATION *stat, const FILE_BASIC_INFO *basic) {
  napi_value result;
  char number[32];
  int64_t mtime, ctime;
  if (basic->LastWriteTime.QuadPart < INT64_MIN + INT64_C(116444736000000000) ||
      basic->ChangeTime.QuadPart < INT64_MIN + INT64_C(116444736000000000)) return NULL;
  mtime = basic->LastWriteTime.QuadPart - INT64_C(116444736000000000);
  ctime = basic->ChangeTime.QuadPart - INT64_C(116444736000000000);
  napi_create_object(env, &result);
  snprintf(number, sizeof number, "%" PRIu32, (uint32_t)stat->dwVolumeSerialNumber); string_property(env, result, "dev", number);
  snprintf(number, sizeof number, "%" PRIu64, ((uint64_t)stat->nFileIndexHigh << 32) | stat->nFileIndexLow); string_property(env, result, "ino", number);
  snprintf(number, sizeof number, "%" PRIu64, ((uint64_t)stat->nFileSizeHigh << 32) | stat->nFileSizeLow); string_property(env, result, "size", number);
  if (mtime) snprintf(number, sizeof number, "%" PRId64 "00", mtime); else strcpy(number, "0");
  string_property(env, result, "mtimeNs", number);
  if (ctime) snprintf(number, sizeof number, "%" PRId64 "00", ctime); else strcpy(number, "0");
  string_property(env, result, "ctimeNs", number);
  return result;
}
#endif

/* A cheap metadata-only call used for discovered children. It never opens file
 * contents or spawns a helper. Directory traversal safety is established by the
 * scanner's independent no-follow probe and the installed process policy. */
static napi_value path_flags(napi_env env, napi_callback_info info) {
  napi_value argument, result, state, allocation, identity = NULL;
  size_t argc = 1, length = 0;
  char *input;
  int hidden = 0, system = 0, reparse = 0, cloud = 0, success = 0;
  double allocated = -1;
  if (!policy_installed) { napi_throw_error(env, "NATIVE_POLICY_UNAVAILABLE", "NATIVE_POLICY_UNAVAILABLE"); return NULL; }
  napi_get_cb_info(env, info, &argc, &argument, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(env, argument, NULL, 0, &length) != napi_ok || !length || length > 131071) {
    napi_throw_error(env, "UNSUPPORTED_PATH", "UNSUPPORTED_PATH"); return NULL;
  }
  input = (char *)malloc(length + 1);
  if (!input) { napi_throw_error(env, "NATIVE_METADATA_UNAVAILABLE", "NATIVE_METADATA_UNAVAILABLE"); return NULL; }
  if (napi_get_value_string_utf8(env, argument, input, length + 1, &length) != napi_ok || memchr(input, 0, length)) {
    free(input); napi_throw_error(env, "UNSUPPORTED_PATH", "UNSUPPORTED_PATH"); return NULL;
  }
#ifdef _WIN32
  {
    wchar_t wide[32768];
    WIN32_FILE_ATTRIBUTE_DATA attributes;
    int i, count;
    memcpy(wide, L"\\\\?\\", 4 * sizeof(wchar_t));
    count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, wide + 4, 32764);
    for (i = 4; count && i < count + 3; i++) if (wide[i] == L'/') wide[i] = L'\\';
    if (count >= 4 && wide[5] == L':' && wide[6] == L'\\' &&
        GetFileAttributesExW(wide, GetFileExInfoStandard, &attributes)) {
      DWORD flags = attributes.dwFileAttributes;
      hidden = !!(flags & FILE_ATTRIBUTE_HIDDEN);
      system = !!(flags & FILE_ATTRIBUTE_SYSTEM);
      reparse = !!(flags & FILE_ATTRIBUTE_REPARSE_POINT);
      cloud = flags & (FILE_ATTRIBUTE_OFFLINE | 0x00040000UL | 0x00400000UL) ? 1 : reparse ? 2 : 0;
      success = 1;
      if (!(flags & FILE_ATTRIBUTE_DIRECTORY) && !reparse && !cloud) {
        HANDLE handle = CreateFileW(wide, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL, NULL);
        if (handle != INVALID_HANDLE_VALUE) {
          BY_HANDLE_FILE_INFORMATION stat;
          FILE_BASIC_INFO basic;
          FILE_STANDARD_INFO standard;
          FILE_COMPRESSION_INFO compressed;
          if (GetFileInformationByHandle(handle, &stat) &&
              GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof basic)) {
            flags = stat.dwFileAttributes;
            hidden = !!(flags & FILE_ATTRIBUTE_HIDDEN); system = !!(flags & FILE_ATTRIBUTE_SYSTEM);
            reparse = !!(flags & FILE_ATTRIBUTE_REPARSE_POINT);
            cloud = flags & (FILE_ATTRIBUTE_OFFLINE | 0x00040000UL | 0x00400000UL) ? 1 : reparse ? 2 : 0;
            if (!(flags & FILE_ATTRIBUTE_DIRECTORY) && !reparse && !cloud) {
              LONGLONG bytes = -1;
              /* Query metadata on this no-follow, attribute-only handle. The
               * standard allocation describes ordinary cluster allocation;
               * sparse/compressed streams need their physical compressed size.
               * Never use the path API GetCompressedFileSizeW, which follows
               * links and returns logical size for an ordinary file. */
              if (flags & (FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED)) {
                if (GetFileInformationByHandleEx(handle, FileCompressionInfo, &compressed, sizeof compressed)) bytes = compressed.CompressedFileSize.QuadPart;
              } else if (GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof standard)) bytes = standard.AllocationSize.QuadPart;
              if (bytes >= 0 && bytes <= INT64_C(9007199254740991)) {
                BY_HANDLE_FILE_INFORMATION after;
                FILE_BASIC_INFO after_basic;
                if (GetFileInformationByHandle(handle, &after) &&
                    GetFileInformationByHandleEx(handle, FileBasicInfo, &after_basic, sizeof after_basic) &&
                    stat.dwVolumeSerialNumber == after.dwVolumeSerialNumber &&
                    stat.nFileIndexHigh == after.nFileIndexHigh && stat.nFileIndexLow == after.nFileIndexLow &&
                    stat.nFileSizeHigh == after.nFileSizeHigh && stat.nFileSizeLow == after.nFileSizeLow &&
                    stat.dwFileAttributes == after.dwFileAttributes &&
                    basic.LastWriteTime.QuadPart == after_basic.LastWriteTime.QuadPart &&
                    basic.ChangeTime.QuadPart == after_basic.ChangeTime.QuadPart) {
                  identity = allocation_identity(env, &stat, &basic);
                  if (identity) allocated = (double)bytes;
                }
              }
            }
          }
          CloseHandle(handle);
        }
      }
    }
  }
#elif defined(__APPLE__)
  {
    struct stat attributes;
    if (!lstat(input, &attributes)) {
      hidden = !!(attributes.st_flags & UF_HIDDEN);
#ifdef SF_RESTRICTED
      system = !!(attributes.st_flags & SF_RESTRICTED);
#endif
      reparse = S_ISLNK(attributes.st_mode);
      cloud = attributes.st_flags & SF_DATALESS ? 1 : 0;
      success = 1;
    }
  }
#endif
  free(input);
  if (!success) { napi_throw_error(env, "NATIVE_METADATA_UNAVAILABLE", "NATIVE_METADATA_UNAVAILABLE"); return NULL; }
  napi_create_object(env, &result);
  boolean_property(env, result, "hidden", hidden);
  boolean_property(env, result, "system", system);
  boolean_property(env, result, "reparsePoint", reparse);
  napi_create_string_utf8(env, cloud == 1 ? "placeholder" : cloud == 2 ? "unknown" : "resident", NAPI_AUTO_LENGTH, &state);
  napi_set_named_property(env, result, "cloudState", state);
  if (allocated >= 0) napi_create_double(env, allocated, &allocation); else napi_get_null(env, &allocation);
  napi_set_named_property(env, result, "allocatedSize", allocation);
  if (!identity) napi_get_null(env, &identity);
  napi_set_named_property(env, result, "allocationIdentity", identity);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, install, NULL, &function);
  napi_set_named_property(env, exports, "install", function);
  napi_create_function(env, "pathFlags", NAPI_AUTO_LENGTH, path_flags, NULL, &function);
  napi_set_named_property(env, exports, "pathFlags", function);
  dh_export_elevation(env, exports);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
