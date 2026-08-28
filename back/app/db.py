from collections.abc import Generator

from sqlmodel import Session, SQLModel, create_engine, select

from .settings import settings


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout_seconds,
    pool_recycle=300,
    pool_use_lifo=True,
)


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session


def check_db_connection() -> None:
    """
    Raises if the DB is not reachable or credentials/DB name are wrong.
    """
    with Session(engine) as session:
        session.exec(select(1)).first()

