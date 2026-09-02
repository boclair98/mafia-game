from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    pass


_engine_options: dict[str, object] = {
    "pool_pre_ping": True,
    "pool_size": settings.database_pool_size,
    "max_overflow": settings.database_max_overflow,
    "pool_timeout": settings.database_pool_timeout,
    "pool_recycle": settings.database_pool_recycle,
}

# SQLite (used by a few lightweight local tools) does not accept asyncpg's
# queue-pool options. Production is PostgreSQL, where the bounded pool above
# prevents a burst of HTTP requests from opening an unbounded number of DB
# connections.
if settings.database_url.startswith("sqlite"):
    _engine_options = {"pool_pre_ping": False}

engine = create_async_engine(settings.database_url, **_engine_options)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        async with session.begin():
            yield session
