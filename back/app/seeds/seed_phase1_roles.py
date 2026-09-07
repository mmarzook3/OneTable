"""Create restricted users only in a signed synthetic fixture.

Stdout contains test credentials: pipe directly to the role test, never log it.
"""
import argparse
import hashlib
import hmac
import json
from pathlib import Path

from sqlmodel import Session, select
from app.db import engine
from app.models import Tenant, User, UserRole
from app.security import get_password_hash
from app.tenant_payment_credentials import tenant_stripe_secret


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest-file', required=True)
    args = parser.parse_args()
    envelope = json.loads(Path(args.manifest_file).read_text(encoding='utf-8-sig'))
    fixture = json.loads(envelope['payload'])
    with Session(engine) as session:
        tenant = session.get(Tenant, fixture['tenant_id'])
        if not tenant:
            raise SystemExit('Synthetic tenant missing')
        key = tenant_stripe_secret(tenant) or ''
        signature = hmac.new(key.encode(), envelope['payload'].encode(), hashlib.sha256).hexdigest()
        if (not key.startswith(('sk_test_', 'rk_test_'))
                or not hmac.compare_digest(signature, envelope['signature'])
                or fixture.get('synthetic') is not True or fixture.get('livemode') is not False
                or tenant.name != f"Scanaki Phase 1 {fixture['run_id']}"):
            raise SystemExit('Signed test fixture required')
        users = []
        for role in (UserRole.kitchen, UserRole.bartender, UserRole.waiter):
            email = f"phase1-{fixture['run_id']}-{role.value}@amvara.de"
            password = hmac.new(key.encode(), f"phase1-role-{fixture['run_id']}-{role.value}".encode(), hashlib.sha256).hexdigest()
            existing = session.exec(select(User).where(User.email == email)).first()
            if existing and (existing.tenant_id != tenant.id or existing.role != role):
                raise SystemExit('Existing test identity mismatch; no changes made')
            if not existing:
                session.add(User(email=email, full_name=f'Synthetic {role.value}',
                    role=role, tenant_id=tenant.id, must_change_password=False,
                    hashed_password=get_password_hash(password)))
            users.append(dict(email=email, password=password, role=role.value, tenantId=tenant.id))
        session.commit()
        print(json.dumps(dict(baseUrl=fixture['base_url'], users=users)))


if __name__ == '__main__':
    main()
