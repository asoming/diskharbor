#define NAPI_VERSION 8
#include <node_api.h>
#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <sddl.h>
#include <objbase.h>
#include <wchar.h>
#include <stdlib.h>

#define DH_HANDOFF_WAIT_MS 15000
#define DH_NONCE_LENGTH 32

/* A ready child still needs cancellation if releasing the JS app fails. Keep
 * that one handle until explicit cancellation or normal process termination. */
static SRWLOCK pending_lock = SRWLOCK_INIT;
static HANDLE pending_cancel = NULL;
static int launch_pending = 0;

static int elevated(void) {
  HANDLE token;
  TOKEN_ELEVATION value;
  DWORD size;
  int ok;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return -1;
  ok = GetTokenInformation(token, TokenElevation, &value, sizeof value, &size);
  CloseHandle(token);
  return ok ? !!value.TokenIsElevated : -1;
}

static napi_value status(napi_env env, napi_callback_info info) {
  napi_value result;
  int value = elevated();
  (void)info;
  if (value < 0) napi_get_null(env, &result);
  else napi_get_boolean(env, value, &result);
  return result;
}

typedef enum {
  DH_FAILED, DH_READY, DH_CANCELLED, DH_READY_TIMEOUT, DH_CHILD_EXITED
} elevation_result;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  HANDLE ready;
  HANDLE cancel;
  elevation_result result;
  wchar_t executable[32768];
  wchar_t arguments[128];
} elevation_work;

/* The current user, SYSTEM and administrators can open this one-shot event.
 * A different administrator account supplied to UAC must also be able to signal
 * readiness. The unpredictable name is created before launching the child. */
static HANDLE create_handoff_event(const wchar_t *name) {
  HANDLE token = NULL, event = NULL;
  TOKEN_USER *user = NULL;
  DWORD length = 0;
  LPWSTR sid = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES attributes = {sizeof attributes, NULL, FALSE};
  wchar_t sddl[512];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  if (!length) goto done;
  user = (TOKEN_USER *)malloc(length);
  if (!user || !GetTokenInformation(token, TokenUser, user, length, &length) ||
      !ConvertSidToStringSidW(user->User.Sid, &sid)) goto done;
  if (swprintf(sddl, 512, L"D:P(A;;0x00100002;;;SY)(A;;0x00100002;;;BA)(A;;0x00100002;;;%ls)", sid) < 0 ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) goto done;
  attributes.lpSecurityDescriptor = descriptor;
  event = CreateEventW(&attributes, TRUE, FALSE, name);
  /* A collision must never let another pre-existing object acknowledge launch. */
  if (event && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(event); event = NULL; }
 done:
  if (descriptor) LocalFree(descriptor);
  if (sid) LocalFree(sid);
  free(user);
  if (token) CloseHandle(token);
  return event;
}

static void launch(napi_env env, void *data) {
  elevation_work *request = (elevation_work *)data;
  SHELLEXECUTEINFOW execution = {0};
  HRESULT initialized;
  HANDLE waits[2];
  DWORD wait, exit_code;
  (void)env;
  initialized = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(initialized)) { SetEvent(request->cancel); return; }
  execution.cbSize = sizeof execution;
  execution.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  execution.lpVerb = L"runas";
  execution.lpFile = request->executable;
  execution.lpParameters = request->arguments;
  execution.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&execution)) {
    if (GetLastError() == ERROR_CANCELLED) request->result = DH_CANCELLED;
    goto done;
  }
  if (!execution.hProcess) goto done;
  /* Process exit wins if the ready event and termination are both signalled. */
  waits[0] = execution.hProcess;
  waits[1] = request->ready;
  wait = WaitForMultipleObjects(2, waits, FALSE, DH_HANDOFF_WAIT_MS);
  if (wait == WAIT_OBJECT_0) request->result = DH_CHILD_EXITED;
  else if (wait == WAIT_TIMEOUT) request->result = DH_READY_TIMEOUT;
  else if (wait == WAIT_OBJECT_0 + 1) {
    if (GetExitCodeProcess(execution.hProcess, &exit_code) && exit_code == STILL_ACTIVE) request->result = DH_READY;
    else request->result = DH_CHILD_EXITED;
  }
 done:
  /* Signal before closing any handle: a child that already opened these
   * objects must not become eligible merely because this parent later exits. */
  if (request->result != DH_READY) SetEvent(request->cancel);
  if (execution.hProcess) CloseHandle(execution.hProcess);
  CoUninitialize();
}

static void launched(napi_env env, napi_status completion, void *data) {
  elevation_work *request = (elevation_work *)data;
  napi_value result, message, error;
  AcquireSRWLockExclusive(&pending_lock);
  launch_pending = 0;
  if (completion == napi_ok && request->result == DH_READY) {
    pending_cancel = request->cancel;
    request->cancel = NULL;
  } else {
    SetEvent(request->cancel);
  }
  ReleaseSRWLockExclusive(&pending_lock);
  if (completion == napi_ok && (request->result == DH_READY || request->result == DH_CANCELLED)) {
    napi_get_boolean(env, request->result == DH_READY, &result);
    napi_resolve_deferred(env, request->deferred, result);
  } else {
    const char *code = request->result == DH_READY_TIMEOUT ? "ELEVATION_READY_TIMEOUT" :
      request->result == DH_CHILD_EXITED ? "ELEVATION_CHILD_EXITED" : "ELEVATION_FAILED";
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, message, message, &error);
    napi_reject_deferred(env, request->deferred, error);
  }
  CloseHandle(request->ready);
  if (request->cancel) CloseHandle(request->cancel);
  napi_delete_async_work(env, request->work);
  free(request);
}

/* Neither a program, path, environment nor command is accepted from JavaScript.
 * The sole target is this executable, with native-generated PID and GUID fields. */
static napi_value restart(napi_env env, napi_callback_info info) {
  napi_value promise, label, unused;
  size_t argc = 1;
  GUID guid;
  wchar_t guid_text[40], nonce[DH_NONCE_LENGTH + 1], event_name[100], cancel_name[110];
  int i, used = 0;
  DWORD length;
  elevation_work *request;
  napi_get_cb_info(env, info, &argc, &unused, NULL, NULL);
  if (argc) { napi_throw_error(env, "ELEVATION_UNAVAILABLE", "ELEVATION_UNAVAILABLE"); return NULL; }
  AcquireSRWLockExclusive(&pending_lock);
  if (launch_pending || pending_cancel) {
    ReleaseSRWLockExclusive(&pending_lock);
    napi_throw_error(env, "ELEVATION_IN_PROGRESS", "ELEVATION_IN_PROGRESS"); return NULL;
  }
  launch_pending = 1;
  ReleaseSRWLockExclusive(&pending_lock);
  request = (elevation_work *)calloc(1, sizeof *request);
  if (!request) goto unavailable;
  length = GetModuleFileNameW(NULL, request->executable, 32768);
  if (!length || length >= 32768 || elevated() != 0 || FAILED(CoCreateGuid(&guid)) ||
      !StringFromGUID2(&guid, guid_text, 40)) goto unavailable;
  for (i = 0; guid_text[i]; i++) {
    wchar_t c = guid_text[i];
    if ((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F')) {
      if (used >= DH_NONCE_LENGTH) goto unavailable;
      nonce[used++] = c;
    }
  }
  if (used != DH_NONCE_LENGTH) goto unavailable;
  nonce[used] = 0;
  if (swprintf(event_name, 100, L"Local\\DiskHarbor.Elevation.%lu.%ls", GetCurrentProcessId(), nonce) < 0 ||
      swprintf(cancel_name, 110, L"Local\\DiskHarbor.Elevation.Cancel.%lu.%ls", GetCurrentProcessId(), nonce) < 0 ||
      swprintf(request->arguments, 128, L"--diskharbor-elevated-restart=%lu:%ls", GetCurrentProcessId(), nonce) < 0) goto unavailable;
  request->cancel = create_handoff_event(cancel_name);
  if (!request->cancel) goto unavailable;
  request->ready = create_handoff_event(event_name);
  if (!request->ready) goto unavailable;
  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "DiskHarbor Windows authorization", NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_async_work(env, NULL, label, launch, launched, request, &request->work) != napi_ok) goto unavailable;
  if (napi_queue_async_work(env, request->work) != napi_ok) {
    napi_delete_async_work(env, request->work);
    goto unavailable;
  }
  return promise;
 unavailable:
  if (request && request->cancel) { SetEvent(request->cancel); CloseHandle(request->cancel); }
  if (request && request->ready) CloseHandle(request->ready);
  free(request);
  AcquireSRWLockExclusive(&pending_lock);
  launch_pending = 0;
  ReleaseSRWLockExclusive(&pending_lock);
  napi_throw_error(env, "ELEVATION_UNAVAILABLE", "ELEVATION_UNAVAILABLE");
  return NULL;
}

/* Internal rollback for a JS release/quit failure after readiness. No PID,
 * event name or handle can be supplied by a caller. */
static napi_value cancel_restart(napi_env env, napi_callback_info info) {
  napi_value result, unused;
  size_t argc = 1;
  int success = 1;
  napi_get_cb_info(env, info, &argc, &unused, NULL, NULL);
  if (argc) { napi_throw_error(env, "ELEVATION_UNAVAILABLE", "ELEVATION_UNAVAILABLE"); return NULL; }
  AcquireSRWLockExclusive(&pending_lock);
  if (launch_pending) success = 0;
  else if (pending_cancel) {
    success = SetEvent(pending_cancel) != 0;
    if (success) { CloseHandle(pending_cancel); pending_cancel = NULL; }
  }
  ReleaseSRWLockExclusive(&pending_lock);
  napi_get_boolean(env, success, &result);
  return result;
}

/* Called before the child opens its profile, after JS has installed the native
 * file policy. Readiness does not authorize arbitrary IPC or a different exe. */
static napi_value wait_parent(napi_env env, napi_callback_info info) {
  napi_value arguments[2], result;
  size_t count = 2, length = 0;
  double numeric_pid = 0;
  DWORD pid, parent_length = 32768, wait;
  int success = 0, i;
  char nonce[DH_NONCE_LENGTH + 1];
  wchar_t wide_nonce[DH_NONCE_LENGTH + 1], event_name[100], cancel_name[110], parent_path[32768], own_path[32768];
  HANDLE parent = NULL, ready = NULL, cancel = NULL, waits[2];
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count != 2 || elevated() != 1 ||
      napi_get_value_double(env, arguments[0], &numeric_pid) != napi_ok ||
      !(numeric_pid >= 1 && numeric_pid <= 4294967295.0) ||
      (double)(DWORD)numeric_pid != numeric_pid ||
      napi_get_value_string_utf8(env, arguments[1], NULL, 0, &length) != napi_ok || length != DH_NONCE_LENGTH ||
      napi_get_value_string_utf8(env, arguments[1], nonce, sizeof nonce, &length) != napi_ok) goto done;
  pid = (DWORD)numeric_pid;
  if (pid == GetCurrentProcessId()) goto done;
  for (i = 0; i < DH_NONCE_LENGTH; i++) {
    char c = nonce[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) goto done;
    wide_nonce[i] = (wchar_t)c;
  }
  wide_nonce[DH_NONCE_LENGTH] = 0;
  parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!parent || !QueryFullProcessImageNameW(parent, 0, parent_path, &parent_length)) goto done;
  length = GetModuleFileNameW(NULL, own_path, 32768);
  if (!length || length >= 32768 || CompareStringOrdinal(parent_path, -1, own_path, -1, TRUE) != CSTR_EQUAL ||
      WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) goto done;
  if (swprintf(event_name, 100, L"Local\\DiskHarbor.Elevation.%lu.%ls", pid, wide_nonce) < 0 ||
      swprintf(cancel_name, 110, L"Local\\DiskHarbor.Elevation.Cancel.%lu.%ls", pid, wide_nonce) < 0) goto done;
  ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name);
  cancel = OpenEventW(SYNCHRONIZE, FALSE, cancel_name);
  if (!ready || !cancel || WaitForSingleObject(cancel, 0) != WAIT_TIMEOUT || !SetEvent(ready)) goto done;
  /* Cancellation wins over a simultaneous parent exit. Recheck it after a
   * parent-only wakeup as well, so late readiness cannot resurrect a failed
   * handoff. The parent never needs PROCESS_TERMINATE on ShellExecute's handle. */
  waits[0] = cancel;
  waits[1] = parent;
  wait = WaitForMultipleObjects(2, waits, FALSE, DH_HANDOFF_WAIT_MS);
  success = wait == WAIT_OBJECT_0 + 1 && WaitForSingleObject(cancel, 0) == WAIT_TIMEOUT;
 done:
  if (cancel) CloseHandle(cancel);
  if (ready) CloseHandle(ready);
  if (parent) CloseHandle(parent);
  napi_get_boolean(env, success, &result);
  return result;
}
#endif

void dh_export_elevation(napi_env env, napi_value exports) {
#ifdef _WIN32
  napi_property_descriptor methods[] = {
    {"elevationStatus", NULL, status, NULL, NULL, NULL, napi_default, NULL},
    {"restartElevated", NULL, restart, NULL, NULL, NULL, napi_default, NULL},
    {"cancelElevatedRestart", NULL, cancel_restart, NULL, NULL, NULL, napi_default, NULL},
    {"waitForRestartParent", NULL, wait_parent, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 4, methods);
#else
  (void)env; (void)exports;
#endif
}
