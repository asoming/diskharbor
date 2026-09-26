{
  "targets": [
    {
      "target_name": "file_policy",
      "sources": ["file-policy.c"],
      "defines": ["NAPI_VERSION=8"],
      "win_delay_load_hook": "true"
    },
    {
      "target_name": "file_probe",
      "type": "executable",
      "sources": ["file-probe.c"],
      "conditions": [
        ["OS=='mac'", {"xcode_settings": {"MACOSX_DEPLOYMENT_TARGET": "12.0"}}]
      ]
    }
  ]
}
