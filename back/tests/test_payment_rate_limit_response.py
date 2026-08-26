"""SlowAPI requires a Response parameter to inject rate-limit headers."""

import inspect
import unittest

from app.main import confirm_payment, create_payment_intent


class TestPaymentRateLimitResponse(unittest.TestCase):
    def test_create_payment_intent_accepts_fastapi_response(self) -> None:
        parameters = inspect.signature(create_payment_intent).parameters
        self.assertIn("request", parameters)
        self.assertIn("response", parameters)

    def test_confirm_payment_accepts_fastapi_response(self) -> None:
        parameters = inspect.signature(confirm_payment).parameters
        self.assertIn("request", parameters)
        self.assertIn("response", parameters)


if __name__ == "__main__":
    unittest.main()
