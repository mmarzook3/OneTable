"""Public table notifications must not carry another browser's order data."""
import json
from unittest.mock import Mock, patch

import pytest

from app.main import publish_order_update


@pytest.mark.parametrize("event_type,expected", [
    ("new_order", "new_order"),
    ("order_paid", "order_paid"),
    ("table_closed", "table_closed"),
    ("cart_updated", "cart_updated"),
    ("private-customer-session", "order_updated"),
    (None, "order_updated"),
    ({"session_id": "private-session"}, "order_updated"),
    (["private-item"], "order_updated"),
])
def test_public_table_receives_only_allowlisted_hint(event_type, expected):
    payload = {
        "type": event_type, "order_id": 321, "status": "paid",
        "notes": "Private order note", "customer_name": "Private customer",
        "session_id": "private-session", "customer_email": "private@scanaki.uk",
        "items": [{"id": 456, "product_name": "Private dish", "notes": "Private item note"}],
        "total_cents": 750, "payment_intent_id": "pi_private",
    }
    redis = Mock()
    with patch("app.main.get_redis", return_value=redis), \
            patch("app.kds_feed_cache.invalidate_kds_feed") as invalidate:
        publish_order_update(17, payload, table_id=42)
    invalidate.assert_called_once_with(17)
    assert redis.publish.call_count == 2
    staff, public = redis.publish.call_args_list
    assert staff.args[0] == "orders:tenant:17"
    assert json.loads(staff.args[1]) == payload
    assert public.args[0] == "orders:table:42"
    assert json.loads(public.args[1]) == {"type": expected}


def test_no_public_notification_without_table():
    redis = Mock()
    payload = {"type": "order_updated", "notes": "Staff-only detail"}
    with patch("app.main.get_redis", return_value=redis), \
            patch("app.kds_feed_cache.invalidate_kds_feed"):
        publish_order_update(17, payload)
    redis.publish.assert_called_once_with("orders:tenant:17", json.dumps(payload))
