"""First-swipe printing: atomic status changes, durable dedupe and agent claims."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlmodel import Session, select

import test_print_jobs as existing
from app import models, print_service
from app.db import engine
from app.main import update_order_kitchen_status


class TestKitchenFirstSwipe(existing.TestPrintJobs):
    def swipe(self, status="preparing", flag=True, user=None):
        body = {"status": status}
        if flag is not None:
            body["print_on_first_swipe"] = flag
        return self.client.put(
            f"/orders/{self.order_id}/kitchen-status",
            headers=existing._bearer_headers(user or self.owner_a),
            json=body,
        )

    def jobs(self):
        return self.session.exec(
            select(models.PrintJob).where(models.PrintJob.order_id == self.order_id)
        ).all()

    def test_first_swipe_retry_reload_revert_and_later_swipes(self):
        self.assertEqual(self.jobs(), [])
        first = self.swipe()
        self.assertEqual(first.status_code, 200, first.text)
        job = first.json()["print_job"]
        self.assertTrue(job["payload"]["first_kitchen_swipe"])
        self.assertFalse(first.json()["print_bridge"]["agent_online"])
        self.session.expire_all()
        self.assertEqual(self.swipe().json()["print_job"]["id"], job["id"])
        for status in ("ready", "delivered"):
            response = self.swipe(status)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIsNone(response.json()["print_job"])
        self.assertEqual(self.swipe("pending", flag=None).status_code, 200)
        saved = self.session.get(models.PrintJob, job["id"])
        saved.status = "done"
        self.session.add(saved)
        self.session.commit()
        self.assertEqual(self.swipe().json()["print_job"]["id"], job["id"])
        self.assertEqual(len(self.jobs()), 1)

    def test_history_correction_and_later_transition_do_not_print(self):
        correction = self.swipe(flag=None)
        self.assertEqual(correction.status_code, 200, correction.text)
        self.assertNotIn("print_job", correction.json())
        self.assertIsNone(self.swipe().json()["print_job"])
        self.assertIsNone(self.swipe("ready").json()["print_job"])
        self.assertIsNone(self.swipe().json()["print_job"])
        self.assertEqual(self.jobs(), [])

    def test_manual_reprints_always_create_new_jobs_and_cannot_set_marker(self):
        first = self.swipe().json()["print_job"]
        ids = {first["id"]}
        for _ in range(2):
            response = self.client.post(
                "/print-jobs", headers=existing._bearer_headers(self.owner_a),
                json={"job_type": "kitchen", "order_id": self.order_id,
                      "payload": {"first_kitchen_swipe": True}},
            )
            self.assertEqual(response.status_code, 200, response.text)
            manual = response.json()["job"]
            self.assertNotIn("first_kitchen_swipe", manual["payload"])
            ids.add(manual["id"])
        self.assertEqual(len(ids), 3)

    def test_mixed_pending_and_preparing_first_swipe_prints_once(self):
        self.assert_mixed_first_swipe_prints_once(models.OrderItemStatus.preparing)

    def test_mixed_pending_and_ready_first_swipe_prints_once(self):
        self.assert_mixed_first_swipe_prints_once(models.OrderItemStatus.ready)

    def assert_mixed_first_swipe_prints_once(self, other_status):
        pending = self.session.exec(select(models.OrderItem).where(
            models.OrderItem.order_id == self.order_id)).first()
        self.session.add(models.OrderItem(
            order_id=self.order_id, product_id=pending.product_id,
            product_name="Already advanced dish", quantity=1, price_cents=100,
            status=other_status,
        ))
        self.session.commit()
        self.assertEqual(self.jobs(), [])
        first = self.swipe()
        self.assertEqual(first.status_code, 200, first.text)
        job = first.json()["print_job"]
        self.assertIsNotNone(job)
        self.assertTrue(job["payload"]["first_kitchen_swipe"])
        self.assertEqual(self.swipe().json()["print_job"]["id"], job["id"])
        self.assertEqual(len(self.jobs()), 1)

    def test_spoofed_manual_marker_before_first_swipe_does_not_suppress_print(self):
        manual_response = self.client.post(
            "/print-jobs", headers=existing._bearer_headers(self.owner_a),
            json={"job_type": "kitchen", "order_id": self.order_id,
                  "payload": {"first_kitchen_swipe": True}},
        )
        self.assertEqual(manual_response.status_code, 200, manual_response.text)
        manual = manual_response.json()["job"]
        self.assertNotIn("first_kitchen_swipe", manual["payload"])
        first = self.swipe()
        self.assertEqual(first.status_code, 200, first.text)
        job = first.json()["print_job"]
        self.assertNotEqual(job["id"], manual["id"])
        self.assertTrue(job["payload"]["first_kitchen_swipe"])
        self.assertEqual(self.swipe().json()["print_job"]["id"], job["id"])
        jobs = self.jobs()
        self.assertEqual(len(jobs), 2)
        self.assertEqual(sum(
            saved.payload.get("first_kitchen_swipe") is True for saved in jobs
        ), 1)

    def test_failed_job_still_deduplicates(self):
        first = self.swipe().json()["print_job"]
        job = self.session.get(models.PrintJob, first["id"])
        job.status = "failed"
        self.session.add(job)
        self.session.commit()
        self.swipe("pending", flag=None)
        self.assertEqual(self.swipe().json()["print_job"]["id"], first["id"])
        self.assertEqual(len(self.jobs()), 1)

    def test_other_tenant_and_cancelled_orders_cannot_print(self):
        self.assertEqual(self.swipe(user=self.owner_b).status_code, 404)
        order = self.session.get(models.Order, self.order_id)
        order.status = models.OrderStatus.cancelled
        self.session.add(order)
        self.session.commit()
        self.assertEqual(self.swipe().status_code, 400)
        self.assertEqual(self.jobs(), [])

    def test_unreleased_prepayment_cannot_print(self):
        order = self.session.get(models.Order, self.order_id)
        order.requires_prepayment = True
        self.session.add(order)
        self.session.commit()
        self.assertEqual(self.swipe().status_code, 409)
        self.assertEqual(self.jobs(), [])

    def test_paid_status_is_preserved(self):
        order = self.session.get(models.Order, self.order_id)
        order.status = models.OrderStatus.paid
        self.session.add(order)
        self.session.commit()
        response = self.swipe()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["order_status"], "paid")
        self.assertIsNotNone(response.json()["print_job"])

    def test_ticket_includes_notes_and_excludes_cancelled_lines(self):
        order = self.session.get(models.Order, self.order_id)
        order.notes = "Serve together"
        item = self.session.exec(select(models.OrderItem).where(
            models.OrderItem.order_id == self.order_id)).first()
        item.notes = "No onions"
        item.customization_summary = "Well done"
        item.line_modifiers_summary = "Extra cheese"
        self.session.add(order)
        self.session.add(item)
        self.session.add(models.OrderItem(
            order_id=self.order_id, product_id=item.product_id,
            product_name="Cancelled dish", quantity=1, price_cents=1,
            status=models.OrderItemStatus.cancelled,
        ))
        self.session.commit()
        response = self.swipe()
        self.assertEqual(response.status_code, 200, response.text)
        ticket = response.json()["print_job"]["payload"]["plain_text"]
        for note in ("Serve together", "No onions", "Well done", "Extra cheese"):
            self.assertIn(note, ticket)
        self.assertNotIn("Cancelled dish", ticket)

    def test_status_and_job_rollback_together(self):
        real_create = print_service.create_job

        def fail_after_insert(*args, **kwargs):
            real_create(*args, **kwargs)
            raise RuntimeError("simulated queue failure")

        with patch.object(print_service, "create_job", side_effect=fail_after_insert):
            with self.assertRaisesRegex(RuntimeError, "simulated queue failure"):
                self.swipe()
        self.session.rollback()
        self.assertEqual(self.jobs(), [])
        item = self.session.exec(select(models.OrderItem).where(
            models.OrderItem.order_id == self.order_id)).first()
        self.assertEqual(item.status, models.OrderItemStatus.pending)
        self.assertEqual(self.swipe().status_code, 200)


@pytest.fixture
def committed_order():
    """Committed synthetic rows allow independent PostgreSQL sessions to contend."""
    with Session(engine) as session:
        tenant = models.Tenant(name="Swipe concurrency " + uuid4().hex)
        session.add(tenant)
        session.flush()
        product = models.Product(tenant_id=tenant.id, name="Test dish", price_cents=100)
        order = models.Order(tenant_id=tenant.id)
        session.add(product)
        session.add(order)
        session.flush()
        item = models.OrderItem(order_id=order.id, product_id=product.id,
                                product_name="Test dish", quantity=1, price_cents=100)
        session.add(item)
        session.commit()
        tenant_id, order_id = tenant.id, order.id
        try:
            yield tenant_id, order_id
        finally:
            session.rollback()
            for model, condition in (
                (models.PrintJob, models.PrintJob.tenant_id == tenant_id),
                (models.PrintAgent, models.PrintAgent.tenant_id == tenant_id),
                (models.OrderItem, models.OrderItem.order_id == order_id),
                (models.Order, models.Order.id == order_id),
                (models.Product, models.Product.tenant_id == tenant_id),
                (models.Tenant, models.Tenant.id == tenant_id),
            ):
                for row in session.exec(select(model).where(condition)).all():
                    session.delete(row)
                session.flush()
            session.commit()


def test_concurrent_first_swipes_create_one_job(committed_order):
    tenant_id, order_id = committed_order
    barrier = Barrier(2)

    def swipe():
        with Session(engine) as session:
            user = models.User(tenant_id=tenant_id, email="concurrency@test.local",
                               hashed_password="unused", role=models.UserRole.kitchen)
            barrier.wait(timeout=10)
            return update_order_kitchen_status(
                order_id, models.OrderKitchenStatusUpdate(
                    status="preparing", print_on_first_swipe=True), user, session,
            )["print_job"]["id"]

    with patch("app.main.publish_order_update"), ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(swipe) for _ in range(2)]
        ids = [future.result(timeout=15) for future in futures]
    assert ids[0] == ids[1]
    with Session(engine) as session:
        jobs = session.exec(select(models.PrintJob).where(
            models.PrintJob.order_id == order_id)).all()
        assert len(jobs) == 1


def test_agent_claim_skips_locked_job(committed_order):
    tenant_id, order_id = committed_order
    with Session(engine) as session:
        agent, _ = print_service.create_agent(session, tenant_id=tenant_id, device_id="claim-test")
        agent_id = agent.id
        jobs = [print_service.create_job(session, tenant_id=tenant_id, user_id=None,
                                        job_type="kitchen", order_id=order_id) for _ in range(2)]
        job_ids = [job.id for job in jobs]
    with Session(engine) as locked, Session(engine) as claimant:
        locked.exec(select(models.PrintJob).where(
            models.PrintJob.id == job_ids[0]).with_for_update()).one()
        # A missing SKIP LOCKED fails promptly instead of hanging the test.
        from sqlalchemy import text
        claimant.exec(text("SET statement_timeout = '2s'"))
        agent = claimant.get(models.PrintAgent, agent_id)
        claimed = print_service.claim_pending_jobs(claimant, agent)
        assert [job.id for job in claimed] == [job_ids[1]]
    with Session(engine) as session:
        agent = session.get(models.PrintAgent, agent_id)
        assert [job.id for job in print_service.claim_pending_jobs(session, agent)] == [job_ids[0]]
        assert print_service.claim_pending_jobs(session, agent) == []
