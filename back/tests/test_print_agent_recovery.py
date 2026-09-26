"""Restart recovery never reprints or takes ownership of another agent's jobs."""

from datetime import datetime, timezone

from pg_client_mixin import PgClientTestCase
from app import models, print_service as svc


class TestPrintAgentRecovery(PgClientTestCase):
    def setUp(self):
        super().setUp()
        a, b = models.Tenant(name="Recovery A"), models.Tenant(name="Recovery B")
        self.session.add_all([a, b])
        self.session.commit()
        self.a, self.token = svc.create_agent(self.session, tenant_id=a.id, device_id="tablet")
        self.other, _ = svc.create_agent(self.session, tenant_id=a.id, device_id="other")
        self.foreign, _ = svc.create_agent(self.session, tenant_id=b.id, device_id="foreign")
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def job(self, status="claimed", agent=None, unowned=False):
        agent = agent or self.a
        job = models.PrintJob(
            tenant_id=agent.tenant_id, job_type="kitchen", printer_role="kitchen",
            status=status, payload={"plain_text": "RECOVERY TEST"},
            claimed_by_agent_id=None if unowned else agent.id,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        self.session.add(job)
        self.session.commit()
        self.session.refresh(job)
        return job

    def complete(self, job, status="done", error="original"):
        return self.client.post(
            f"/print-agent/jobs/{job.id}/complete", headers=self.headers,
            json={"status": status, "error_message": error},
        )

    def test_claimed_is_bounded_fifo_owned_and_read_only(self):
        own = [self.job() for _ in range(52)]
        excluded = [self.job(agent=self.other), self.job(agent=self.foreign),
                    self.job("pending", unowned=True), self.job("done"),
                    self.job("failed"), self.job("cancelled")]
        response = self.client.get("/print-agent/jobs/claimed", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([j["id"] for j in response.json()], [j.id for j in own[:50]])
        limited = self.client.get("/print-agent/jobs/claimed?limit=2", headers=self.headers)
        self.assertEqual([j["id"] for j in limited.json()], [j.id for j in own[:2]])
        for job in own + excluded:
            before = (job.status, job.claimed_by_agent_id, job.completed_at)
            self.session.refresh(job)
            self.assertEqual((job.status, job.claimed_by_agent_id, job.completed_at), before)
        for limit in (0, 51):
            self.assertEqual(self.client.get(
                f"/print-agent/jobs/claimed?limit={limit}", headers=self.headers
            ).status_code, 422)

    def test_auth_and_revocation(self):
        job = self.job()
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            self.assertEqual(self.client.get("/print-agent/jobs/claimed", headers=headers).status_code, 401)
        self.assertEqual(self.client.get("/print-agent/jobs/claimed", headers={
            "X-Print-Agent-Token": self.token
        }).status_code, 200)
        svc.revoke_agent(self.session, self.a.tenant_id, self.a.id)
        self.assertEqual(self.client.get("/print-agent/jobs/claimed", headers=self.headers).status_code, 401)
        self.assertEqual(self.complete(job).status_code, 401)

    def test_terminal_retries_are_unchanged_and_conflicts_rejected(self):
        for status, conflict in (("done", "failed"), ("failed", "done")):
            job = self.job()
            first = self.complete(job, status)
            self.assertEqual(first.status_code, 200, first.text)
            repeated = self.complete(job, status, "different retry error")
            self.assertEqual(repeated.status_code, 200, repeated.text)
            self.assertEqual(repeated.json(), first.json())
            self.assertEqual(self.complete(job, conflict).status_code, 409)
            self.session.refresh(job)
            self.assertEqual(svc.job_to_dict(job), first.json())
        self.assertEqual(self.client.get("/print-agent/jobs/claimed", headers=self.headers).json(), [])

    def test_unclaimed_cancelled_wrong_agent_and_tenant_refused(self):
        cases = [(self.job("pending", unowned=True), 409),
                 (self.job("cancelled"), 409), (self.job("pending"), 409),
                 (self.job(agent=self.other), 403),
                 (self.job("done", agent=self.other), 403),
                 (self.job(agent=self.foreign), 404)]
        for job, expected in cases:
            before = svc.job_to_dict(job)
            response = self.complete(job)
            self.assertEqual(response.status_code, expected, response.text)
            self.session.refresh(job)
            self.assertEqual(svc.job_to_dict(job), before)
