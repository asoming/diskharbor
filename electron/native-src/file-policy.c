#define NAPI_VERSION 8
#include <node_api.h>
#include "file-policy.h"

static napi_value install(napi_env env, napi_callback_info info) {
  napi_value result;
  (void)info;
  napi_get_boolean(env, dh_install_policy() != 0, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, install, NULL, &function);
  napi_set_named_property(env, exports, "install", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
