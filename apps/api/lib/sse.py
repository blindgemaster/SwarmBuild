"""
SSE Event Bus — In-process pub/sub for Server-Sent Events

Provides a singleton event bus that allows any part of the API to publish
events to all connected SSE clients. Used alongside the existing WebSocket
manager for real-time delivery.
"""

import asyncio
import json
from typing import AsyncGenerator


class SSEEventBus:
    """Singleton event bus for Server-Sent Events."""
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._subscribers = []
        return cls._instance

    async def publish(self, event_type: str, data: dict):
        """Publish an event to all subscribers."""
        event = {"type": event_type, "data": data}
        dead = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(queue)
        for q in dead:
            self._subscribers.remove(q)

    def subscribe(self) -> asyncio.Queue:
        """Create a new subscriber queue."""
        queue = asyncio.Queue(maxsize=100)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        """Remove a subscriber."""
        if queue in self._subscribers:
            self._subscribers.remove(queue)


event_bus = SSEEventBus()
