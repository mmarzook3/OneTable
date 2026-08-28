"""Send one operational alert through the Platform SMTP configuration."""

from __future__ import annotations

import argparse
import asyncio
import html

from app.email_service import send_email


async def _send(recipient: str, subject: str, message: str) -> bool:
    escaped = html.escape(message)
    return await send_email(
        recipient,
        subject,
        f"<p>Scanaki operations reported a failure:</p><pre>{escaped}</pre>",
        text_content=f"Scanaki operations reported a failure:\n\n{message}",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipient", required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--message", required=True)
    args = parser.parse_args()
    sent = asyncio.run(_send(args.recipient, args.subject, args.message))
    if not sent:
        raise SystemExit("Platform SMTP alert delivery failed")
    print(f"Platform alert accepted for {args.recipient}")


if __name__ == "__main__":
    main()
