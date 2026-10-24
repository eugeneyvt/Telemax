#!/usr/bin/env python3
"""Independent, content-free bridge monitoring. Never prints tokens, URLs or private config."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


def evaluate(status, now):
    if not isinstance(status, dict) or status.get('schema') != 1:
        return ['invalid-health-response']
    at = status.get('at')
    if not isinstance(at, (int, float)) or not now - 120_000 <= at <= now + 60_000:
        return ['stale-heartbeat']
    reasons = list(status.get('reasons', [])) if not status.get('ok') else []
    if status.get('attention', 0) > 0:
        reasons.append('delivery-needs-attention')
    return sorted(set(str(reason) for reason in reasons))


def transition(state, reasons, now):
    result = dict(state)
    result['checkedAt'] = now
    result['reasons'] = reasons
    result['failures'] = state.get('failures', 0) + 1 if reasons else 0
    message = None
    if reasons and result['failures'] >= 3:
        changed = reasons != state.get('alertedReasons')
        if (not state.get('alarmActive') or changed) and now - state.get('lastAttemptAt', 0) >= 300:
            message = '⚠️ Мост MAX требует внимания: ' + ', '.join(reasons) + '. Проверка идёт с отдельного сервера. Если Telegram работает, откройте /panel и /queue.'
    elif not reasons and state.get('alarmActive'):
        if now - state.get('lastAttemptAt', 0) >= 60:
            message = '✅ Мост MAX восстановился: соединения и очередь снова в норме.'
    return result, message


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_suffix('.partial')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
    temporary.replace(file)


def check(config):
    request = urllib.request.Request(config['url'], headers={'Authorization': 'Bearer ' + config['healthToken']})
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        if error.code != 503:
            return ['health-endpoint-unavailable']
        response = error
    except (OSError, urllib.error.URLError):
        return ['server-unreachable']
    try:
        with response:
            return evaluate(json.loads(response.read(64 * 1024)), time.time() * 1000)
    except (ValueError, OSError):
        return ['invalid-health-response']


def notify(config, text):
    body = json.dumps({'chat_id': config['telegramChat'], 'text': text, 'disable_web_page_preview': True}).encode()
    request = urllib.request.Request('https://api.telegram.org/bot' + config['telegramToken'] + '/sendMessage', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        if not json.load(response).get('ok'):
            raise RuntimeError('notification-rejected')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    reasons = check(config)
    if args.check_only:
        print(json.dumps({'ok': not reasons, 'reasons': reasons}))
        return
    file = Path(config['stateFile'])
    try:
        previous = json.loads(file.read_text())
    except FileNotFoundError:
        previous = {}
    now = time.time()
    state, message = transition(previous, reasons, now)
    if message:
        # Save a cooldown before the request: a lost Telegram ACK must not cause a notification storm.
        state['lastAttemptAt'] = now
        save(file, state)
        try:
            notify(config, message)
            state['alarmActive'] = bool(reasons)
            state['alertedReasons'] = reasons
            state['lastNotifiedAt'] = now
        except Exception as error:
            print('Notification unavailable:', type(error).__name__)
    save(file, state)
    print('Bridge check:', 'attention' if reasons else 'healthy')


if __name__ == '__main__':
    main()
