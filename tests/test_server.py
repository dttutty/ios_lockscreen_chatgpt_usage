from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import UsageServerError, load_env_file, normalize_rate_limits


class NormalizeRateLimitsTests(unittest.TestCase):
    def test_prefers_requested_multi_bucket(self) -> None:
        result = {
            "rateLimits": {
                "primary": {
                    "usedPercent": 99,
                    "windowDurationMins": 15,
                    "resetsAt": 100,
                }
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {
                        "usedPercent": 26,
                        "windowDurationMins": 10080,
                        "resetsAt": 200,
                    },
                    "secondary": None,
                }
            },
        }

        normalized = normalize_rate_limits(result, now=123)

        self.assertEqual(
            normalized,
            {
                "primary": {
                    "usedPercent": 26,
                    "windowDurationMins": 10080,
                    "resetsAt": 200,
                },
                "secondary": None,
                "updatedAt": 123,
            },
        )

    def test_supports_primary_and_secondary_windows(self) -> None:
        result = {
            "rateLimits": {
                "primary": {
                    "usedPercent": 23.5,
                    "windowDurationMins": 300,
                    "resetsAt": 100,
                },
                "secondary": {
                    "usedPercent": 41,
                    "windowDurationMins": 10080,
                    "resetsAt": 200,
                },
            }
        }

        normalized = normalize_rate_limits(result, now=123)

        self.assertEqual(normalized["primary"]["usedPercent"], 23.5)
        self.assertEqual(normalized["secondary"]["windowDurationMins"], 10080)

    def test_rejects_response_without_windows(self) -> None:
        with self.assertRaisesRegex(UsageServerError, "without usable windows"):
            normalize_rate_limits({"rateLimits": {}})


class EnvironmentFileTests(unittest.TestCase):
    def test_loads_values_without_overwriting_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("FIRST=value\nSECOND='from file'\n", encoding="utf-8")
            with patch.dict(os.environ, {"SECOND": "exported"}, clear=True):
                load_env_file(env_file)
                self.assertEqual(os.environ["FIRST"], "value")
                self.assertEqual(os.environ["SECOND"], "exported")

    def test_rejects_invalid_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("not valid\n", encoding="utf-8")
            with self.assertRaisesRegex(UsageServerError, "Invalid environment entry"):
                load_env_file(env_file)


if __name__ == "__main__":
    unittest.main()
