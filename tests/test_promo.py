import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import promo  # noqa: E402


class PromoPayloadTests(unittest.TestCase):
    def test_promo_payload_includes_copy_and_directories(self) -> None:
        out = promo.promo_payload(
            product_name="Deeperguard",
            public_host="www.deeperguard.com",
            public_url="https://www.deeperguard.com",
            app_path="/app",
            contact_email="notes@deeperguard.com",
            billing_note="Free during public beta",
        )
        self.assertTrue(out["ok"])
        self.assertIn("reddit", out["copy"])
        self.assertIn("hacker_news_title", out["copy"])
        self.assertGreater(len(out["directories"]), 3)
        self.assertEqual(out["structured_data"]["@type"], "WebApplication")


if __name__ == "__main__":
    unittest.main()
