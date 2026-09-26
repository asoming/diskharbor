#ifndef DISKHARBOR_FILE_POLICY_H
#define DISKHARBOR_FILE_POLICY_H

/* No content access is permitted unless both process and calling-thread policy
 * can be installed and read back. Child helpers install their own policy.
 * Apple TN3150; Microsoft Rtl*PlaceholderCompatibilityMode documentation. */
#ifdef _WIN32
#include <windows.h>
static int dh_install_policy(void) {
  typedef CHAR (WINAPI *set_mode)(CHAR);
  typedef CHAR (WINAPI *query_mode)(void);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  set_mode set_process, set_thread;
  query_mode query_process, query_thread;
  if (!ntdll) return 0;
  set_process = (set_mode)GetProcAddress(ntdll, "RtlSetProcessPlaceholderCompatibilityMode");
  set_thread = (set_mode)GetProcAddress(ntdll, "RtlSetThreadPlaceholderCompatibilityMode");
  query_process = (query_mode)GetProcAddress(ntdll, "RtlQueryProcessPlaceholderCompatibilityMode");
  query_thread = (query_mode)GetProcAddress(ntdll, "RtlQueryThreadPlaceholderCompatibilityMode");
  if (!set_process || !set_thread || !query_process || !query_thread) return 0;
  if (set_process(2) < 0 || set_thread(2) < 0) return 0;
  return query_process() == 2 && query_thread() == 2;
}
#elif defined(__APPLE__)
#include <sys/resource.h>
static int dh_install_policy(void) {
#if defined(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES) && defined(IOPOL_MATERIALIZE_DATALESS_FILES_OFF)
  int type = IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES;
  int off = IOPOL_MATERIALIZE_DATALESS_FILES_OFF;
  if (setiopolicy_np(type, IOPOL_SCOPE_PROCESS, off) != 0 ||
      setiopolicy_np(type, IOPOL_SCOPE_THREAD, off) != 0) return 0;
  return getiopolicy_np(type, IOPOL_SCOPE_PROCESS) == off &&
    getiopolicy_np(type, IOPOL_SCOPE_THREAD) == off;
#else
  return 0;
#endif
}
#else
static int dh_install_policy(void) { return 0; }
#endif
#endif
