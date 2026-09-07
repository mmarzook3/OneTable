"""Read the existing launch checklist without exposing tenant contacts or keys."""
import argparse
import json

from sqlmodel import Session
from app.db import engine
from app.models import Tenant
from app.platform_routes import _tenant_detail


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenant-id', type=int, required=True)
    parser.add_argument('--require-ready', action='store_true')
    args = parser.parse_args()
    with Session(engine) as session:
        tenant = session.get(Tenant, args.tenant_id)
        if not tenant:
            raise SystemExit('Tenant not found')
        readiness = _tenant_detail(session, tenant).readiness
        print(json.dumps({'tenant_id': tenant.id, 'readiness': readiness}))
        if args.require_ready and not readiness['ready']:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
