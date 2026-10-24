#!/usr/bin/env python3
"""Restart only a running Telemax whose event loop stopped producing heartbeats."""
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/srv/telemax')


def should_restart(health, running, state, now):
    return bool(running and isinstance(health.get('at'), (int, float))
                and now * 1000 - health['at'] > 180_000
                and now - state.get('lastRestartAt', 0) >= 900)


def main():
    if (ROOT / 'maintenance').exists():
        print('Telemax maintenance mode')
        return
    state_file = ROOT / 'watchdog-state.json'
    try:
        state = json.loads(state_file.read_text())
    except FileNotFoundError:
        state = {}
    try:
        health = json.loads((ROOT / 'data/health.json').read_text())
    except (FileNotFoundError, ValueError):
        print('No readable heartbeat; no blind restart')
        return
    running = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'telemax-telemax-1'], text=True, timeout=15).strip() == 'true'
    now = time.time()
    if should_restart(health, running, state, now):
        temporary = state_file.with_suffix('.partial')
        temporary.write_text(json.dumps({'lastRestartAt': now}))
        os.chmod(temporary, 0o600)
        temporary.replace(state_file)
        subprocess.run(['docker', 'compose', '-f', str(ROOT / 'compose.yaml'), 'restart', 'telemax'], check=True, timeout=90)
        print('Restarted Telemax after stale event-loop heartbeat')
    else:
        print('No Telemax restart required')


if __name__ == '__main__':
    main()
