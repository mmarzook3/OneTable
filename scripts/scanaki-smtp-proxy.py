#!/usr/bin/env python3
"""Private, fixed-destination SMTP transport; STARTTLS stays end-to-end."""
import asyncio
import socket

ACTIVE = 0


async def pipe(reader, writer):
    while True:
        data = await asyncio.wait_for(reader.read(65536), 120)
        if not data:
            return
        writer.write(data)
        await writer.drain()


async def handle(reader, writer):
    global ACTIVE
    peer = writer.get_extra_info('peername')
    upstream = None
    tasks = []
    if not peer or peer[0] != '10.77.0.2' or ACTIVE >= 16:
        writer.close()
        return
    ACTIVE += 1
    try:
        remote, upstream = await asyncio.wait_for(
            asyncio.open_connection('smtp-relay.gmail.com', 587, family=socket.AF_INET), 10
        )
        tasks = [asyncio.create_task(pipe(reader, upstream)),
                 asyncio.create_task(pipe(remote, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, asyncio.TimeoutError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        if upstream:
            upstream.close()
        ACTIVE -= 1


async def main():
    server = await asyncio.start_server(handle, '10.77.0.1', 2587, backlog=16)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
