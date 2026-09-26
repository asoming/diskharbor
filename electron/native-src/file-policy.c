#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include "file-policy.h"
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

/* A cheap metadata-only call used for discovered children. It never opens file
 * contents or spawns a helper. Directory traversal safety is established by the
 * scanner's independent no-follow probe and the installed process policy. */
static napi_value path_flags(napi_env env, napi_callback_info info) {
  napi_value argument, result, state;
  size_t argc = 1, length = 0;
  char *input;
  int hidden = 0, system = 0, reparse = 0, cloud = 0, success = 0;
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
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, install, NULL, &function);
  napi_set_named_property(env, exports, "install", function);
  napi_create_function(env, "pathFlags", NAPI_AUTO_LENGTH, path_flags, NULL, &function);
  napi_set_named_property(env, exports, "pathFlags", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
