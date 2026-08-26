"""Create or update one platform operator without putting its password in code or shell history.

Usage inside the backend container:

    printf '%s\n' "$PASSWORD" | python -m app.seeds.set_platform_operator USERNAME

The password is read from standard input, hashed immediately, and never printed.
"""

from __future__ import annotations

import sys

from sqlalchemy import func
from sqlmodel import Session, select

from app import models, security
from app.db import engine


def set_platform_operator(username: str, password: str) -> int:
    clean_username = username.strip()
    if len(clean_username) < 3 or len(clean_username) > 320 or any(ch.isspace() for ch in clean_username):
        raise ValueError("Platform username must be 3-320 characters without spaces")
    if len(password) < 12:
        raise ValueError("Platform password must contain at least 12 characters")
    with Session(engine) as session:
        user = session.exec(
            select(models.User).where(func.lower(models.User.email) == clean_username.lower())
        ).first()
        if user is not None and user.role != models.UserRole.platform_operator:
            raise ValueError("That username belongs to a non-platform account")
        if user is None:
            user = models.User(
                email=clean_username,
                hashed_password="",
                full_name="Scanaki Super Admin",
                role=models.UserRole.platform_operator,
            )
        user.email = clean_username
        user.hashed_password = security.get_password_hash(password)
        user.role = models.UserRole.platform_operator
        user.tenant_id = None
        user.provider_id = None
        user.must_change_password = False
        user.otp_enabled = False
        user.otp_secret = None
        user.token_version = int(user.token_version or 0) + 1
        session.add(user)
        session.commit()
        session.refresh(user)
        return int(user.id)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python -m app.seeds.set_platform_operator USERNAME", file=sys.stderr)
        return 2
    password = sys.stdin.readline().rstrip("\r\n")
    if not password:
        print("Password is required on standard input", file=sys.stderr)
        return 2
    try:
        user_id = set_platform_operator(sys.argv[1], password)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"Platform operator ready (user id {user_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
