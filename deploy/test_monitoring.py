import importlib.util
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load('observer')
watchdog = load('watchdog')


class MonitoringTests(unittest.TestCase):
    def test_no_alert_for_healthy_or_brief_failure(self):
        state = {}
        for now, reasons in [(1000, []), (1060, ['server-unreachable']), (1120, [])]:
            state, message = observer.transition(state, reasons, now)
            self.assertIsNone(message)

    def test_persistent_failure_alerts_then_stays_quiet(self):
        state = {}
        for now in [1000, 1060]:
            state, message = observer.transition(state, ['server-unreachable'], now)
            self.assertIsNone(message)
        state, message = observer.transition(state, ['server-unreachable'], 1120)
        self.assertIn('требует внимания', message)
        state.update(alarmActive=True, alertedReasons=['server-unreachable'], lastAttemptAt=1120)
        for now in [1180, 1600, 999999]:
            state, message = observer.transition(state, ['server-unreachable'], now)
            self.assertIsNone(message)
        state, message = observer.transition(state, [], 1000000)
        self.assertIn('восстановился', message)

    def test_stale_or_invalid_health_is_not_green(self):
        self.assertEqual(observer.evaluate({}, 1000000), ['invalid-health-response'])
        self.assertEqual(observer.evaluate({'schema': 1, 'at': 1, 'ok': True}, 1000000), ['stale-heartbeat'])
        self.assertEqual(observer.evaluate({'schema': 1, 'at': 1000000, 'ok': True, 'attention': 2}, 1000000), ['delivery-needs-attention'])

    def test_restart_only_a_running_stalled_process_with_cooldown(self):
        self.assertTrue(watchdog.should_restart({'at': 1000000}, True, {}, 2000))
        self.assertFalse(watchdog.should_restart({'at': 1990000}, True, {}, 2000))
        self.assertFalse(watchdog.should_restart({'at': 1000000}, False, {}, 2000))
        self.assertFalse(watchdog.should_restart({'at': 1000000}, True, {'lastRestartAt': 1900}, 2000))


if __name__ == '__main__':
    unittest.main()
