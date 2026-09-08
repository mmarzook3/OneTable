"""Explicit disposable fixture helper; never an ordinary-discovery test.

Run only against the selected backend container, with existing dependencies.
The seed command prints a PRIVATE fixture containing a short-lived JWT. Capture
stdout into a variable and pipe it directly to test-group-shared-actions.mjs.
Never echo that variable, persist its contents, or enable shell tracing.

PowerShell local example (from the repository root):
  $helper = Get-Content -Raw scripts/phase3-group-actions-fixture.py
  $private = $helper | docker exec -i pos-back python - seed --target local
  if ($LASTEXITCODE -ne 0) { throw 'Private fixture creation failed' }
  # Do not print $private or $fixture.
  $fixture = $private | ConvertFrom-Json
  try {
    $private | docker exec -i pos-front node /app/scripts/test-group-shared-actions.mjs --execute --allow-synthetic
  } finally {
    $helper | docker exec -i pos-back python - cleanup --run-id $fixture.run_id --tenant-ids $fixture.source.tenant_id $fixture.own.tenant_id --group-id $fixture.group_id --catalog-id $fixture.catalog_id
  }

For a separately authorized VPS run, pipe the helper to
  ssh gatlieros-vps 'docker exec -i scanaki-back python - seed --target vps'
and use that same VPS backend for cleanup with the returned nonce/IDs. The browser
test can still run in the existing local pos-front container. Never mix targets.
Always run cleanup after browser failure as well as success. Only sanitized test
and cleanup outputs may be retained. No installs, provider calls, or app edits.
"""
import argparse
import json
import secrets
import uuid
import warnings
from datetime import timedelta

def seed(args):
    from sqlmodel import Session
    from app import models, security
    from app.db import engine

    assert args.target in ('local', 'vps')
    run_id = uuid.uuid4().hex
    result = {'synthetic': True, 'run_id': run_id, 'target': args.target,
              'base_url': 'http://haproxy:4202' if args.target == 'local' else 'https://scanaki.uk'}
    with Session(engine) as session:
        with session.begin():
            group = models.RestaurantGroup(name='Synthetic Group Actions ' + run_id,
                join_code=secrets.token_urlsafe(9), share_products=True, share_customers=True)
            catalog = models.ProductCatalog(name='Synthetic Group Actions Catalog ' + run_id,
                normalized_name='synthetic group actions catalog ' + run_id,
                category='Synthetic Group Actions')
            session.add_all([group, catalog]); session.flush()
            result.update(group_id=group.id, catalog_id=catalog.id, catalog_name=catalog.name)
            for letter in ('A', 'B'):
                tenant = models.Tenant(name=f'Scanaki Group Actions {run_id} {letter}',
                    is_demo=False, onboarding_status='completed', saas_subscription_status='grandfathered',
                    saas_plan_code='pro', currency_code='GBP', timezone='UTC',
                    require_kds_online=False, location_check_enabled=False, tse_mode='off')
                session.add(tenant); session.flush()
                owner = models.User(email=f'group-actions-{run_id}-{letter.lower()}@amvara.de',
                    full_name=f'Synthetic Group Actions Owner {letter}',
                    hashed_password=security.get_password_hash(secrets.token_urlsafe(30)),
                    role=models.UserRole.owner, tenant_id=tenant.id, must_change_password=False)
                customer = models.BillingCustomer(tenant_id=tenant.id,
                    name=f'Synthetic Group Actions CRM {letter} {run_id}')
                session.add_all([owner, customer,
                    models.RestaurantGroupMember(group_id=group.id, tenant_id=tenant.id)])
                session.flush()
                actor = {'tenant_id': tenant.id, 'customer_id': customer.id, 'customer_name': customer.name}
                if letter == 'A':
                    product = models.TenantProduct(tenant_id=tenant.id, catalog_id=catalog.id,
                        name='Synthetic Group Actions Product A ' + run_id,
                        price_cents=500, is_active=True)
                    session.add(product); session.flush()
                    actor['product_id'] = product.id
                    result['source'] = actor
                else:
                    result['own'] = actor
                    result['owner_token'] = security.create_access_token(
                        {'sub': owner.email, 'tenant_id': tenant.id, 'token_version': owner.token_version},
                        expires_delta=timedelta(minutes=15))
    # Caller must capture this privately and pipe to the browser, never log it.
    print(json.dumps(result))


def cleanup(args):
    from sqlalchemy import MetaData, delete, func, select, update
    from app import models
    from app.db import engine

    assert args.run_id and len(args.run_id) == 32 and all(c in '0123456789abcdef' for c in args.run_id)
    assert args.tenant_ids and len(set(args.tenant_ids)) == 2 and 23 not in args.tenant_ids
    assert args.group_id and args.catalog_id
    warnings.filterwarnings('ignore', category=Warning)
    metadata = MetaData(); metadata.reflect(bind=engine)
    with engine.begin() as connection:
        tenant = metadata.tables['tenant']
        group = metadata.tables['restaurant_group']
        catalog = metadata.tables[models.ProductCatalog.__table__.name]
        names = connection.execute(select(tenant.c.name).where(tenant.c.id.in_(args.tenant_ids))).scalars().all()
        assert sorted(names) == sorted([f'Scanaki Group Actions {args.run_id} {x}' for x in ('A', 'B')])
        assert connection.execute(select(group.c.name).where(group.c.id == args.group_id)).scalar_one() == 'Synthetic Group Actions ' + args.run_id
        assert connection.execute(select(catalog.c.name).where(catalog.c.id == args.catalog_id)).scalar_one() == 'Synthetic Group Actions Catalog ' + args.run_id
        scope = {'tenant': tenant.c.id.in_(args.tenant_ids), 'restaurant_group': group.c.id == args.group_id,
                 catalog.name: catalog.c.id == args.catalog_id}
        for table in metadata.tables.values():
            if 'tenant_id' in table.c:
                predicate = table.c.tenant_id.in_(args.tenant_ids)
                if connection.execute(select(func.count()).select_from(table).where(predicate)).scalar_one():
                    scope[table.name] = predicate
        ignored = set()
        for fk in tenant.foreign_keys:
            if fk.column.table.name in scope:
                assert fk.parent.nullable
                connection.execute(update(tenant).where(tenant.c.id.in_(args.tenant_ids)).values({fk.parent.name: None}))
                ignored.add(('tenant', fk.parent.name))
        pending = set(scope); sequence = []
        while pending:
            leaves = [name for name in pending if not any(
                fk.column.table.name == name and table.name != name and (table.name, fk.parent.name) not in ignored
                for table in metadata.tables.values() if table.name in pending for fk in table.foreign_keys)]
            assert leaves, 'Owned cleanup dependency cycle'
            sequence.extend(leaves); pending.difference_update(leaves)
        removed = {name: connection.execute(delete(metadata.tables[name]).where(scope[name])).rowcount for name in sequence}
        assert connection.execute(select(func.count()).select_from(tenant).where(tenant.c.id.in_(args.tenant_ids))).scalar_one() == 0
        assert connection.execute(select(func.count()).select_from(group).where(group.c.id == args.group_id)).scalar_one() == 0
        assert connection.execute(select(func.count()).select_from(catalog).where(catalog.c.id == args.catalog_id)).scalar_one() == 0
    print(json.dumps({'result': 'CLEANUP PASS', 'run_id': args.run_id,
        'tenant_ids': args.tenant_ids, 'group_id': args.group_id, 'catalog_id': args.catalog_id,
        'rows_deleted': removed, 'remaining_owned_rows': 0}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['seed', 'cleanup'])
    parser.add_argument('--target', choices=['local', 'vps'])
    parser.add_argument('--run-id')
    parser.add_argument('--tenant-ids', nargs=2, type=int)
    parser.add_argument('--group-id', type=int)
    parser.add_argument('--catalog-id', type=int)
    args = parser.parse_args()
    try:
        seed(args) if args.mode == 'seed' else cleanup(args)
    except Exception as error:
        print(json.dumps({'result': 'FIXTURE OPERATION FAILED', 'mode': args.mode, 'error_type': type(error).__name__}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
