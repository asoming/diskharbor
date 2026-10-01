"""Operate on one independently checked, test-owned private Trash item."""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote, unquote

from gi.repository import Gio


def main():
    action, name, expected_path = sys.argv[1:]
    base = Path(os.environ["DISKHARBOR_STORAGE_DIR"])
    assert base.parent == Path(__file__).resolve().parents[1] / "output"
    assert re.fullmatch(r"storage-acceptance-[0-9a-f-]+", base.name)
    assert base.resolve() == base
    bootstrap = json.loads((base / "bootstrap.json").read_text())
    address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    assert address.startswith(bootstrap["listen"] + ",")
    assert address != bootstrap["originalBus"]
    assert os.environ.get("HOME") == bootstrap["originalHome"]
    stat = base.lstat()
    assert {"dev": str(stat.st_dev), "ino": str(stat.st_ino)} == bootstrap["fixtureIdentity"]
    assert stat.st_uid == os.getuid() and stat.st_mode & 0o777 == 0o700
    trash = base / "xdg-data" / "Trash"
    assert trash.resolve() == trash
    assert (trash / "files").resolve() == trash / "files"
    assert (trash / "info").resolve() == trash / "info"
    assert Path(os.environ["XDG_DATA_HOME"]) == trash.parent
    assert name == Path(name).name and name not in (".", "..")
    original = Path(expected_path)
    assert original.is_relative_to(base / "files")
    assert original.parent.resolve() == original.parent
    info = trash / "info" / (name + ".trashinfo")
    payload = trash / "files" / name
    assert info.is_file() and not info.is_symlink()
    assert payload.exists() and not payload.is_symlink()
    paths = re.findall(r"^Path=(.*)$", info.read_text(), re.MULTILINE)
    assert len(paths) == 1 and unquote(paths[0]) == expected_path
    item = Gio.File.new_for_uri("trash:///" + quote(name, safe=""))
    metadata = item.query_info("trash::orig-path", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, None)
    # Use the actual byte-string value, never GIO CLI's printable \xhh form.
    native_original = metadata.get_attribute_byte_string("trash::orig-path")
    assert native_original == expected_path
    if action == "restore":
        item.move(Gio.File.new_for_path(native_original), Gio.FileCopyFlags.NONE, None, None, None)
    elif action == "remove-owned-item":
        # This is an external test actor, not a production permanent-delete API.
        # It never lists or empties Trash, and cannot target an unverified URI.
        item.delete(None)
    else:
        raise ValueError("Unsupported private acceptance operation")
    print(json.dumps({"action": action, "nativeOriginalPath": native_original, "result": "passed"}))


if __name__ == "__main__":
    main()
