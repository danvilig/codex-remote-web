#!/usr/bin/env python3
"""Exercise the installed Codex sandbox without an LLM or production files."""
import json
import pathlib
import socket
import subprocess
import tempfile
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
artifacts = root / '.artifacts' / 'environment'
artifacts.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='sandbox-boundary-', dir=artifacts) as workspace:
    outside = artifacts / ('outside-' + uuid.uuid4().hex + '.txt')
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    script = r'''
import json, pathlib, socket, sys
inside = pathlib.Path('inside.txt')
inside.write_text('SANDBOX_WRITE_OK\n')
result = {'workspaceWrite': inside.read_text().strip() == 'SANDBOX_WRITE_OK'}
try:
    pathlib.Path(sys.argv[1]).write_text('UNEXPECTED\n')
    result['outsideWriteDenied'] = False
except OSError as error:
    result['outsideWriteDenied'] = True
    result['outsideErrno'] = error.errno
try:
    with socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=2):
        result['hostNetworkDenied'] = False
except OSError as error:
    result['hostNetworkDenied'] = True
    result['networkErrno'] = error.errno
result['apparmorLabel'] = pathlib.Path('/proc/self/attr/current').read_text().strip()
print(json.dumps(result))
'''
    try:
        run = subprocess.run(['codex', 'sandbox', '-P', ':workspace', '-C', workspace,
                              '-c', 'sandbox_mode="workspace-write"',
                              '-c', 'sandbox_workspace_write.network_access=false',
                              '--', 'python3', '-c', script, str(outside), str(listener.getsockname()[1])],
                             capture_output=True, text=True, timeout=20)
        if run.returncode:
            raise RuntimeError(f'Codex sandbox failed ({run.returncode}): {run.stderr[:1500]}')
        result = json.loads(run.stdout)
        result['outsideFileAbsent'] = not outside.exists()
        assert result['workspaceWrite'] and result['outsideWriteDenied'] and result['hostNetworkDenied'] and result['outsideFileAbsent'], result
        (artifacts / 'sandbox-boundary.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    finally:
        listener.close()
        outside.unlink(missing_ok=True)
