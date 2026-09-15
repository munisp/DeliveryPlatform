import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ["INTERNAL_SERVICE_TOKEN"] = "verification-test-token"
os.environ["VERIFICATION_SYNTHETIC_MODE"] = "true"
import main  # noqa: E402
import screening  # noqa: E402

TOKEN = "verification-test-token"


class ScreenNameHeuristicTests(unittest.TestCase):
    def test_snake_is_implausible_and_flagged(self):
        result = screening.screen_name("Snake")
        self.assertFalse(result["plausible"])
        self.assertLess(result["score"], 0.5)
        self.assertTrue(result["flags"])

    def test_mr_dot_is_implausible(self):
        result = screening.screen_name("Mr. Dot")
        self.assertFalse(result["plausible"])
        self.assertIn("placeholder_name", result["flags"])

    def test_adaeze_okonkwo_is_plausible(self):
        result = screening.screen_name("Adaeze Okonkwo")
        self.assertTrue(result["plausible"])
        self.assertGreaterEqual(result["score"], 0.5)
        self.assertEqual(result["flags"], [])

    def test_single_character_is_implausible(self):
        result = screening.screen_name("A")
        self.assertFalse(result["plausible"])
        self.assertIn("single_character", result["flags"])

    def test_digits_only_is_implausible(self):
        result = screening.screen_name("12345")
        self.assertFalse(result["plausible"])
        self.assertIn("digits_only", result["flags"])

    def test_score_is_bounded_and_deterministic(self):
        for name in ["Snake", "Adaeze Okonkwo", "A", "12345", "😀😀", "aaaa", "qzxkv"]:
            first = screening.screen_name(name)
            second = screening.screen_name(name)
            self.assertEqual(first, second)
            self.assertGreaterEqual(first["score"], 0.0)
            self.assertLessEqual(first["score"], 1.0)

    def test_common_nigerian_names_are_plausible(self):
        for name in ["Musa Bello", "Chiamaka Eze", "Oluwaseun Adebayo", "Fatima Yusuf"]:
            self.assertTrue(screening.screen_name(name)["plausible"], name)


class NinFormatTests(unittest.TestCase):
    def test_valid_nin_format(self):
        ok, flags = screening.validate_nin_format("12345678901")
        self.assertTrue(ok)
        self.assertEqual(flags, [])

    def test_all_same_digit_is_invalid(self):
        ok, flags = screening.validate_nin_format("11111111111")
        self.assertFalse(ok)
        self.assertIn("nin_all_same_digit", flags)

    def test_sequential_cycle_is_invalid(self):
        ok, flags = screening.validate_nin_format("01234567890")
        self.assertFalse(ok)
        self.assertIn("nin_sequential_digits", flags)

    def test_wrong_length_is_invalid(self):
        ok, flags = screening.validate_nin_format("12345")
        self.assertFalse(ok)
        self.assertIn("nin_not_11_digits", flags)

    def test_missing_nin_is_neutral(self):
        ok, flags = screening.validate_nin_format(None)
        self.assertIsNone(ok)
        self.assertEqual(flags, [])


class ManifestVerifyTests(unittest.TestCase):
    def test_manifest_with_mixed_valid_and_invalid_passengers(self):
        request = main.ManifestVerifyRequest(
            passengers=[
                {"name": "Adaeze Okonkwo", "nin": "12345678901"},
                {"name": "Snake", "nin": "11111111111"},
            ]
        )
        response = main.verify_passenger_manifest(request, TOKEN)
        self.assertEqual(len(response.results), 2)

        first = response.results[0]
        self.assertEqual(first.name, "Adaeze Okonkwo")
        self.assertTrue(first.name_ok)
        self.assertTrue(first.nin_format_ok)
        self.assertEqual(first.flags, [])

        second = response.results[1]
        self.assertEqual(second.name, "Snake")
        self.assertFalse(second.name_ok)
        self.assertFalse(second.nin_format_ok)
        self.assertIn("nin_all_same_digit", second.flags)

    def test_manifest_passenger_without_nin_reports_null(self):
        request = main.ManifestVerifyRequest(passengers=[{"name": "Musa Bello"}])
        response = main.verify_passenger_manifest(request, TOKEN)
        self.assertIsNone(response.results[0].nin_format_ok)
        self.assertTrue(response.results[0].name_ok)


class ScreenNameRouteTests(unittest.TestCase):
    def test_screen_name_route(self):
        request = main.ScreenNameRequest(name="Mr. Dot")
        response = main.screen_rider_name(request, TOKEN)
        self.assertFalse(response.plausible)
        self.assertLess(response.score, 0.5)
        self.assertIn("placeholder_name", response.flags)

    def test_routes_require_internal_token(self):
        with self.assertRaises(Exception) as raised:
            main.screen_rider_name(main.ScreenNameRequest(name="Snake"), "wrong-token")
        self.assertEqual(raised.exception.status_code, 401)
        with self.assertRaises(Exception) as raised:
            main.verify_passenger_manifest(
                main.ManifestVerifyRequest(passengers=[{"name": "Snake"}]), None
            )
        self.assertEqual(raised.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
