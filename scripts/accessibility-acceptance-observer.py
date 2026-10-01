#!/usr/bin/env python3
"""Read one owned Electron PID through an explicitly isolated AT-SPI bus."""
import json
import os
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def observe(pid):
    base = os.environ.get("DISKHARBOR_ACCESSIBILITY_DIR", "")
    address = "unix:abstract=" + os.path.basename(base)
    if not os.path.isabs(base) or not os.path.basename(base).startswith("accessibility-acceptance-"):
        raise RuntimeError("INVALID_FIXTURE_ROOT")
    if os.environ.get("AT_SPI_BUS_ADDRESS") != address or os.environ.get("DISKHARBOR_PRIVATE_ATSPI") != address:
        raise RuntimeError("PRIVATE_ACCESSIBILITY_BUS_REQUIRED")
    desktop = Atspi.get_desktop(0)
    application = None
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and application is None:
        for index in range(desktop.get_child_count()):
            candidate = desktop.get_child_at_index(index)
            # No names, contents or descendants are read for any other PID.
            if candidate and candidate.get_process_id() == pid:
                application = candidate
                break
        if application is None:
            time.sleep(0.1)
    if application is None:
        raise RuntimeError("OWNED_APPLICATION_NOT_EXPOSED_TO_ATSPI")
    nodes = []

    def visit(node, parent, depth):
        if depth > 40 or len(nodes) >= 2000:
            raise RuntimeError("ACCESSIBILITY_TREE_LIMIT_EXCEEDED")
        identity = len(nodes)
        state_set = node.get_state_set()
        states = [state.value_nick for state in state_set.get_states()]
        nodes.append({"id": identity, "parent": parent, "role": node.get_role_name(),
                      "name": node.get_name(), "description": node.get_description(),
                      "states": states, "attributes": node.get_attributes()})
        for index in range(node.get_child_count()):
            child = node.get_child_at_index(index)
            if child is not None:
                visit(child, identity, depth + 1)

    visit(application, None, 0)
    return {"pid": pid, "nativeBridge": "AT-SPI", "nodes": nodes}


if __name__ == "__main__":
    try:
        print(json.dumps(observe(int(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
