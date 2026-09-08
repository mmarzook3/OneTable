"""Run only in an isolated database: metadata bootstrap and migration failure gates."""
import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import pytest

if not (
    os.environ.get('SCANAKI_ISOLATED_TEST_DB') == '1'
    and os.environ.get('DB_NAME') == 'scanaki_phase3_test'
    and os.environ.get('DB_HOST') == '127.0.0.1'
):
    pytest.skip('Requires the explicitly isolated Phase 3 runner', allow_module_level=True)

from sqlmodel import Session, text

from app.db import engine
from app.migrate import MigrationRunner


def test_metadata_bootstrap_runs_full_history_and_preserves_settings():
    from app import main
    main.create_db_and_tables()
    migrations = Path(__file__).resolve().parents[1] / 'migrations'
    runner = MigrationRunner(migrations)
    latest = max(int(path.name.split('_')[0]) for path in migrations.glob('*.sql')
                 if path.name.split('_')[0].isdigit())
    assert runner.run_migrations() == latest
    with Session(engine) as session:
        row = session.exec(text('SELECT smtp_auth_required, remember_session_days, '
                                'remember_inactivity_days FROM platform_settings WHERE id=1')).one()
        assert tuple(row) == (True, 10, 5)
        session.exec(text('UPDATE platform_settings SET smtp_auth_required=false, '
                          'remember_session_days=7, remember_inactivity_days=3 WHERE id=1'))
        session.commit()
        sql = (migrations / '20260825030000_platform_settings.sql').read_text()
        for statement in runner._split_sql_statements(sql):
            session.exec(text(statement))
        session.commit()
        row = session.exec(text('SELECT smtp_auth_required, remember_session_days, '
                                'remember_inactivity_days FROM platform_settings WHERE id=1')).one()
        assert tuple(row) == (False, 7, 3)
    assert runner.run_migrations() == latest


def test_migration_failure_prevents_lifespan_startup():
    from app.main import _app_lifespan, app

    async def start():
        async with _app_lifespan(app):
            pytest.fail('Application must not serve after a migration failure')

    with patch('app.main.create_db_and_tables'), patch(
        'app.migrate.MigrationRunner.run_migrations', side_effect=RuntimeError('synthetic migration failure')
    ):
        with pytest.raises(RuntimeError, match='synthetic migration failure'):
            asyncio.run(start())
