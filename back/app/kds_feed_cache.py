"""Short-lived Redis cache and single-flight lock for the Kitchen display feed."""

from __future__ import annotations

import asyncio
import os
from uuid import uuid4

import redis


_CACHE_TTL_SECONDS = 5
_LOCK_TTL_SECONDS = 5
_WAIT_SECONDS = 1.5
_client: redis.Redis | None = None


def _redis() -> redis.Redis | None:
    global _client
    if _client is not None:
        return _client
    try:
        candidate = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
        candidate.ping()
        _client = candidate
    except Exception:
        _client = None
    return _client


def _version(client: redis.Redis, tenant_id: int) -> int:
    raw = client.get(f"kds:feed:version:{tenant_id}")
    return int(raw or 0)


def _cache_key(tenant_id: int, limit: int, version: int) -> str:
    return f"kds:feed:{tenant_id}:{version}:{limit}"


def invalidate_kds_feed(tenant_id: int) -> None:
    """Make all cached snapshots for a tenant obsolete without a Redis key scan."""
    client = _redis()
    if client is None:
        return
    try:
        client.incr(f"kds:feed:version:{tenant_id}")
    except Exception:
        # Redis is an optimisation only; database-backed ordering must keep working.
        pass


def get_kds_feed(tenant_id: int, limit: int) -> bytes | None:
    client = _redis()
    if client is None:
        return None
    try:
        return client.get(_cache_key(tenant_id, limit, _version(client, tenant_id)))
    except Exception:
        return None


def begin_kds_feed_build(tenant_id: int, limit: int) -> tuple[str, str, int] | None:
    """Acquire the per-snapshot lock and return its key, token, and feed version."""
    client = _redis()
    if client is None:
        return None
    try:
        version = _version(client, tenant_id)
        lock_key = f"{_cache_key(tenant_id, limit, version)}:lock"
        token = uuid4().hex
        if client.set(lock_key, token, nx=True, ex=_LOCK_TTL_SECONDS):
            return lock_key, token, version
    except Exception:
        pass
    return None


async def wait_for_kds_feed(tenant_id: int, limit: int) -> bytes | None:
    """Wait without occupying a server worker for the request owning the build lock."""
    client = _redis()
    if client is None:
        return None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _WAIT_SECONDS
    while loop.time() < deadline:
        try:
            cached = client.get(_cache_key(tenant_id, limit, _version(client, tenant_id)))
            if cached is not None:
                return cached
        except Exception:
            return None
        await asyncio.sleep(0.02)
    return None


def finish_kds_feed_build(
    tenant_id: int,
    limit: int,
    payload: bytes,
    ownership: tuple[str, str, int] | None,
) -> None:
    client = _redis()
    if client is None:
        return
    try:
        build_version = ownership[2] if ownership is not None else _version(client, tenant_id)
        # An order update during the build increments the version. In that case,
        # discard this now-stale result instead of publishing it as current.
        if _version(client, tenant_id) == build_version:
            client.set(
                _cache_key(tenant_id, limit, build_version),
                payload,
                ex=_CACHE_TTL_SECONDS,
            )
    except Exception:
        pass
    finally:
        if ownership is None:
            return
        lock_key, token, _ = ownership
        try:
            client.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then "
                "return redis.call('del', KEYS[1]) else return 0 end",
                1,
                lock_key,
                token,
            )
        except Exception:
            pass
