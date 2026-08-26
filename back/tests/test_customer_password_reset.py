"""End-user customer password recovery is isolated from staff accounts."""

from unittest.mock import AsyncMock, patch

from pg_client_mixin import PgClientTestCase

from app import models, security


class TestCustomerPasswordReset(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        from app.settings import settings

        self._previous_base = settings.public_app_base_url
        settings.public_app_base_url = "http://127.0.0.1:4202"
        self.customer = models.Customer(
            email="customer-reset@amvara.de",
            hashed_password=security.get_password_hash("customer-old-9"),
            email_verified=True,
        )
        self.session.add(self.customer)
        self.session.commit()
        self.session.refresh(self.customer)

    def tearDown(self) -> None:
        from app.settings import settings

        settings.public_app_base_url = self._previous_base
        super().tearDown()

    @patch("app.customer_routes.email_svc.send_password_reset_email", new_callable=AsyncMock)
    def test_request_confirm_and_single_use(self, mock_send: AsyncMock) -> None:
        mock_send.return_value = True
        requested = self.client.post(
            "/customer/password-reset/request",
            json={"email": self.customer.email},
        )
        self.assertEqual(requested.status_code, 200, requested.text)
        mock_send.assert_awaited_once()
        reset_url = mock_send.call_args.args[1]
        self.assertIn("/customer/reset-password?token=", reset_url)
        token = reset_url.split("token=", 1)[1]

        confirmed = self.client.post(
            "/customer/password-reset/confirm",
            json={"token": token, "new_password": "customer-new-88"},
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.session.refresh(self.customer)
        self.assertTrue(
            security.verify_password("customer-new-88", self.customer.hashed_password)
        )
        self.assertGreaterEqual(self.customer.token_version, 1)

        reused = self.client.post(
            "/customer/password-reset/confirm",
            json={"token": token, "new_password": "customer-next-99"},
        )
        self.assertEqual(reused.status_code, 400, reused.text)

    @patch("app.customer_routes.email_svc.send_password_reset_email", new_callable=AsyncMock)
    def test_unknown_customer_is_not_disclosed(self, mock_send: AsyncMock) -> None:
        response = self.client.post(
            "/customer/password-reset/request",
            json={"email": "unknown-customer@amvara.de"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        mock_send.assert_not_awaited()
