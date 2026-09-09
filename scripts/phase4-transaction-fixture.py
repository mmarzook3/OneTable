"""Explicit disposable Phase4 fixture. Private seed JSON stdout; cleanup JSON stdin.

Run in the existing backend container with --execute --allow-synthetic.
Caller must always invoke cleanup after browser exit, including failure.
No provider credentials are copied and no external services are invoked.
"""
import argparse
import hashlib
import json
import re
import sys
import uuid
from datetime import timedelta

PROTECTED = (147, 149, 157)


def require(condition):
    if not condition:
        raise ValueError('Synthetic fixture guard failed')


def fingerprint(session, m, select):
    rows = session.exec(select(m.Order).where(m.Order.id.in_(PROTECTED))).all()
    payments = session.exec(select(m.OrderPayment).where(m.OrderPayment.order_id.in_(PROTECTED))).all()
    data = [r.model_dump(mode='json') for r in sorted(rows, key=lambda r: r.id)]
    data += [r.model_dump(mode='json') for r in sorted(payments, key=lambda r: r.id)]
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def run(action, recovery_stdin=False):
    require(action != 'seed' or recovery_stdin)
    from sqlmodel import Session, SQLModel, select
    from sqlalchemy import delete, func, text
    from app import models as m, security
    from app.db import engine

    with Session(engine) as s:
        if action == 'prepare':
            nonce = uuid.uuid4().hex
            print(json.dumps(dict(synthetic=True, nonce=nonce, marker='Phase4 Cash '+nonce,
                deviceKey='phase4-'+nonce, protected=fingerprint(s, m, select))))
            return
        state = json.load(sys.stdin)
        if state is not None:
            nonce = state.get('nonce', '')
            require(state.get('synthetic') is True and re.fullmatch(r'[a-f0-9]{32}', nonce))
            require(state['marker'] == 'Phase4 Cash '+nonce and state['deviceKey'] == 'phase4-'+nonce)
            require(re.fullmatch(r'[a-f0-9]{64}', state['protected']))
            # Serialize seed/recovery for this identity, including a lost seed response.
            lock_id = int.from_bytes(hashlib.sha256(nonce.encode()).digest()[:8], 'big', signed=True)
            s.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': lock_id})
        if action == 'seed':
            nonce = state['nonce']
            marker = 'Phase4 Cash ' + nonce
            baseline = fingerprint(s, m, select)
            require(not s.exec(select(m.Tenant).where(m.Tenant.name == marker)).all())
            require(baseline == state['protected'])
            tenant = m.Tenant(name=marker, timezone='UTC', currency='GBP', currency_code='GBP',
                tse_mode='off', ordering_mode='automatic', immediate_payment_required=False,
                require_kds_online=False, reservation_reminder_24h_enabled=False,
                reservation_reminder_2h_enabled=False)
            s.add(tenant); s.flush()
            floor = m.Floor(tenant_id=tenant.id, name=marker, sort_order=0)
            s.add(floor); s.flush()
            table = m.Table(tenant_id=tenant.id, floor_id=floor.id, name='Synthetic Table',
                token=uuid.uuid4().hex, is_active=True, x_position=0, y_position=0,
                rotation=0, shape='rect', width=1, height=1, seat_count=4)
            owner = m.User(tenant_id=tenant.id, email='phase4-'+nonce+'@amvara.de',
                hashed_password=security.get_password_hash(uuid.uuid4().hex), full_name='Synthetic Owner',
                role=m.UserRole.owner, must_change_password=False)
            s.add(table); s.add(owner)
            products = []
            for suffix, category, price in [('Soup', 'Main Course', 500), ('Water', 'Beverages', 200)]:
                product = m.Product(tenant_id=tenant.id, name=marker+' '+suffix,
                    category=category, price_cents=price)
                s.add(product); products.append(product)
            s.flush()
            require(tenant.id not in (1, 23, 25))
            state = dict(synthetic=True, nonce=nonce, marker=marker, tenantId=tenant.id,
                tableId=table.id, tableToken=table.token, deviceKey='phase4-'+nonce,
                protected=baseline, products=[dict(id=p.id, name=p.name, price=p.price_cents,
                    category=p.category) for p in products])
            state['token'] = security.create_access_token(dict(sub=owner.email, tenant_id=tenant.id,
                provider_id=None, token_version=owner.token_version), expires_delta=timedelta(minutes=20))
            s.commit()
            print(json.dumps(state))
            return

        import warnings
        from app.onetable_ordering import _get_pulse_redis
        nonce = state.get('nonce', '')
        require(re.fullmatch(r'[a-f0-9]{32}', nonce))
        tenants = s.exec(select(m.Tenant).where(m.Tenant.name == state['marker'])).all()
        require(len(tenants) <= 1)
        if not tenants:
            print(json.dumps(dict(cleanup='PASS', fixture_absent=True)))
            return
        tenant = tenants[0]
        tid = tenant.id
        require(type(tid) is int and tid not in (1, 23, 25))
        require('tenantId' not in state or state['tenantId'] == tid)
        require(tenant and tenant.name == state['marker'] == 'Phase4 Cash '+nonce)
        require(state['deviceKey'] == 'phase4-'+nonce)
        owners = s.exec(select(m.User).where(m.User.tenant_id == tid)).all()
        require(len(owners) == 1 and owners[0].email == 'phase4-'+nonce+'@amvara.de'
            and owners[0].role == m.UserRole.owner and owners[0].full_name == 'Synthetic Owner')
        floors = s.exec(select(m.Floor).where(m.Floor.tenant_id == tid)).all()
        require(len(floors) == 1 and floors[0].name == state['marker'])
        fixture_tables = s.exec(select(m.Table).where(m.Table.tenant_id == tid)).all()
        require(len(fixture_tables) == 1)
        table = fixture_tables[0]
        require(table.name == 'Synthetic Table' and table.floor_id == floors[0].id)
        require('tableId' not in state or table.id == state['tableId'])
        require(table and table.tenant_id == tid)
        if 'tableTokenHash' in state:
            require(hashlib.sha256(table.token.encode()).hexdigest() == state['tableTokenHash'])
        orders = s.exec(select(m.Order).where(m.Order.tenant_id == tid)).all()
        require(len(orders) <= 1)
        require(all(o.id not in PROTECTED and o.notes == state['marker'] and o.table_id == table.id
            and not o.stripe_payment_intent_id and not o.revolut_order_id for o in orders))
        payments = s.exec(select(m.OrderPayment).where(m.OrderPayment.tenant_id == tid)).all()
        require(all(p.payment_method == 'cash' and not p.stripe_payment_intent_id for p in payments))
        products = s.exec(select(m.Product).where(m.Product.tenant_id == tid)).all()
        if 'products' in state:
            require({p.id for p in products} == {p['id'] for p in state['products']})
        require(len(products) == 2 and {(p.name, p.category, p.price_cents) for p in products} == {
            (state['marker']+' Soup', 'Main Course', 500),
            (state['marker']+' Water', 'Beverages', 200)})
        redis = _get_pulse_redis()
        require(redis is not None)
        keys = [f'kds:pulse:{tid}:latest', f'kds:pulse:{tid}:{state["deviceKey"]}']
        # Exact newly owned tenant/device keys only; never SCAN or global flush.
        redis.delete(*keys)
        require(not any(redis.exists(k) for k in keys))
        ids = [o.id for o in orders]
        pids = [p.id for p in payments]
        if pids:
            s.execute(delete(m.OrderPaymentItem).where(m.OrderPaymentItem.order_payment_id.in_(pids)))
        if ids:
            s.execute(delete(m.OrderItem).where(m.OrderItem.order_id.in_(ids)))
        # Tenant/default-tax FK cycle must be broken only on this fixture row.
        if hasattr(tenant, 'default_tax_id'):
            tenant.default_tax_id = None; s.add(tenant); s.flush()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore'); tables = list(SQLModel.metadata.sorted_tables)
        for tbl in reversed(tables):
            if 'tenant_id' in tbl.c:
                s.execute(delete(tbl).where(tbl.c.tenant_id == tid))
        s.execute(delete(m.Tenant).where(m.Tenant.id == tid))
        s.flush(); s.expire_all()
        require(s.get(m.Tenant, tid) is None)
        require(fingerprint(s, m, select) == state['protected'])
        for tbl in tables:
            if 'tenant_id' in tbl.c:
                require(s.execute(select(func.count()).select_from(tbl).where(tbl.c.tenant_id == tid)).scalar_one() == 0)
        s.commit()
        print(json.dumps(dict(cleanup='PASS', tenant_removed=tid, orders_removed=len(ids),
            redis_fixture_keys_absent=True, protected_orders_unchanged=True)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'seed', 'cleanup'])
    parser.add_argument('--recovery-stdin', action='store_true')
    parser.add_argument('--execute', action='store_true', required=True)
    parser.add_argument('--allow-synthetic', action='store_true', required=True)
    args = parser.parse_args()
    try:
        run(args.action, args.recovery_stdin)
    except Exception as exc:
        print(json.dumps(dict(result='FAIL', action=args.action, error_type=type(exc).__name__)), file=sys.stderr)
        sys.exit(1)
