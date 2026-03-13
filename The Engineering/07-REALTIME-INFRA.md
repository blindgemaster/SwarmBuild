# 07 — Real-Time Infrastructure

> **Problem**: v1 uses in-memory WebSocket dictionaries. When the API server restarts (Render cold starts, deploys), all WebSocket connections are lost and cannot be recovered. This also prevents horizontal scaling to multiple server instances.
>
> **Solution**: Redis pub/sub for WebSocket fan-out, SSE as a fallback, and connection recovery.

---

## Table of Contents

1. [Current Architecture & Issues](#current-architecture--issues)
2. [Redis Pub/Sub Design](#redis-pubsub-design)
3. [Connection Recovery](#connection-recovery)
4. [SSE Fallback Channel](#sse-fallback-channel)
5. [Event Types & Schema](#event-types--schema)
6. [Implementation Details](#implementation-details)

---

## Current Architecture & Issues

### v1 Architecture

```python
# apps/api/lib/websocket.py — Current implementation
class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}  # In-memory!

    async def broadcast(self, job_id: str, message: dict):
        for connection in self.active_connections.get(job_id, []):
            await connection.send_json(message)
```

### Issues

| Issue | Impact |
|-------|--------|
| In-memory storage | Server restart = all connections lost |
| Single-process | Can't scale to multiple API instances |
| No reconnection protocol | Client must manually reconnect + re-fetch all state |
| No event ordering | Messages can arrive out of order during rapid updates |
| No persistence | Missed events during disconnection are lost forever |
| Separate systems | Lobby WS and Log WS are completely separate codebases |

---

## Redis Pub/Sub Design

### Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ API #1   │     │ API #2   │     │ API #3   │
│ (Render) │     │ (Render) │     │ (Render) │
│          │     │          │     │          │
│ WS: 50   │     │ WS: 30   │     │ WS: 20   │
│ clients  │     │ clients  │     │ clients  │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
     └────────────────┼────────────────┘
                      │
              ┌───────▼────────┐
              │   Redis        │
              │   Pub/Sub      │
              │                │
              │   Channels:    │
              │   job:{id}     │
              │   logs:{id}    │
              │   system       │
              └────────────────┘
```

### How It Works

1. **Producer** (any API instance): When a task is updated, message posted, etc., the handler publishes to a Redis channel
2. **Redis**: Fans out the message to all subscribers
3. **Consumers** (all API instances): Each instance subscribes to relevant channels and forwards messages to its local WebSocket connections

### Updated WebSocket Manager

```python
# apps/api/lib/websocket.py — v2 with Redis

import aioredis
import json
import asyncio
from fastapi import WebSocket
from typing import Optional


class RedisConnectionManager:
    """
    WebSocket manager backed by Redis pub/sub.
    Supports horizontal scaling across multiple API instances.
    """

    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self.redis: Optional[aioredis.Redis] = None
        self.pubsub: Optional[aioredis.client.PubSub] = None
        self.local_connections: dict[str, list[WebSocket]] = {}
        self._subscriber_task: Optional[asyncio.Task] = None
        self._event_counter: int = 0  # For ordering

    async def initialize(self):
        """Connect to Redis and start subscriber."""
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)
        self.pubsub = self.redis.pubsub()
        self._subscriber_task = asyncio.create_task(self._subscriber_loop())
        print(f"[ws] Redis pub/sub connected")

    async def shutdown(self):
        """Cleanup on shutdown."""
        if self._subscriber_task:
            self._subscriber_task.cancel()
        if self.pubsub:
            await self.pubsub.unsubscribe()
            await self.pubsub.close()
        if self.redis:
            await self.redis.close()

    # ── Connection Management ──

    async def connect(self, websocket: WebSocket, channel: str):
        """Accept a WebSocket connection and subscribe to its channel."""
        await websocket.accept()

        if channel not in self.local_connections:
            self.local_connections[channel] = []
            # Subscribe to Redis channel when first client connects
            await self.pubsub.subscribe(f"ws:{channel}")

        self.local_connections[channel].append(websocket)
        print(f"[ws] +1 connection on {channel} (total: {len(self.local_connections[channel])})")

    async def disconnect(self, websocket: WebSocket, channel: str):
        """Remove a WebSocket connection."""
        if channel in self.local_connections:
            self.local_connections[channel] = [
                ws for ws in self.local_connections[channel] if ws != websocket
            ]
            if not self.local_connections[channel]:
                del self.local_connections[channel]
                await self.pubsub.unsubscribe(f"ws:{channel}")
        print(f"[ws] -1 connection on {channel}")

    # ── Publishing (any API instance can call this) ──

    async def broadcast(self, channel: str, message: dict):
        """Publish a message to all instances via Redis."""
        self._event_counter += 1
        envelope = {
            "seq": self._event_counter,
            "timestamp": datetime.utcnow().isoformat(),
            "data": message,
        }
        await self.redis.publish(f"ws:{channel}", json.dumps(envelope))

    # ── Subscriber (receives messages from Redis, forwards to local WS) ──

    async def _subscriber_loop(self):
        """Infinite loop that reads Redis pub/sub messages and forwards to local WebSockets."""
        try:
            while True:
                message = await self.pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message and message["type"] == "message":
                    channel = message["channel"].replace("ws:", "")
                    data = json.loads(message["data"])
                    await self._forward_to_local(channel, data)
                await asyncio.sleep(0.01)  # Yield to event loop
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[ws] Subscriber error: {e}")

    async def _forward_to_local(self, channel: str, envelope: dict):
        """Forward a message to all local WebSocket connections for a channel."""
        connections = self.local_connections.get(channel, [])
        dead = []
        for ws in connections:
            try:
                await ws.send_json(envelope)
            except Exception:
                dead.append(ws)
        # Clean up dead connections
        for ws in dead:
            await self.disconnect(ws, channel)


# Global instance (initialized in lifespan)
manager = RedisConnectionManager(os.environ.get("REDIS_URL", "redis://localhost:6379"))
```

---

## Connection Recovery

### Problem: Client Reconnects After Server Restart

When a WebSocket connection drops, the client needs to:
1. Reconnect
2. Know what events it missed
3. Catch up without re-fetching everything

### Solution: Event Sequence Numbers + Replay

Each event has a `seq` number. The client tracks the last `seq` it received. On reconnect, it sends `?last_seq=42` and the server replays missed events.

### Event Replay Storage

```python
# Events are stored in Redis sorted sets with TTL for replay window

async def broadcast(self, channel: str, message: dict):
    self._event_counter += 1
    envelope = {
        "seq": self._event_counter,
        "timestamp": datetime.utcnow().isoformat(),
        "data": message,
    }
    payload = json.dumps(envelope)

    # Publish for real-time delivery
    await self.redis.publish(f"ws:{channel}", payload)

    # Store for replay (keep last 1000 events, expire after 1 hour)
    await self.redis.zadd(f"replay:{channel}", {payload: self._event_counter})
    await self.redis.zremrangebyrank(f"replay:{channel}", 0, -1001)
    await self.redis.expire(f"replay:{channel}", 3600)


async def replay_since(self, channel: str, last_seq: int) -> list:
    """Get all events after a given sequence number."""
    events = await self.redis.zrangebyscore(
        f"replay:{channel}",
        min=last_seq + 1,
        max="+inf"
    )
    return [json.loads(e) for e in events]
```

### Client-Side Reconnection

```typescript
// apps/web/lib/ws-client.ts

class ReconnectingWebSocket {
    private ws: WebSocket | null = null;
    private lastSeq: number = 0;
    private reconnectDelay: number = 1000;
    private maxReconnectDelay: number = 30000;
    private url: string;
    private onMessage: (data: any) => void;

    constructor(url: string, onMessage: (data: any) => void) {
        this.url = url;
        this.onMessage = onMessage;
        this.connect();
    }

    private connect() {
        const connectUrl = this.lastSeq > 0
            ? `${this.url}?last_seq=${this.lastSeq}`
            : this.url;

        this.ws = new WebSocket(connectUrl);

        this.ws.onopen = () => {
            console.log("[ws] Connected");
            this.reconnectDelay = 1000; // Reset backoff
        };

        this.ws.onmessage = (event) => {
            const envelope = JSON.parse(event.data);
            if (envelope.seq) {
                this.lastSeq = envelope.seq;
            }
            this.onMessage(envelope.data);
        };

        this.ws.onclose = () => {
            console.log(`[ws] Disconnected. Reconnecting in ${this.reconnectDelay}ms...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        };
    }

    close() {
        if (this.ws) this.ws.close();
    }
}
```

---

## SSE Fallback Channel

### Why SSE?

Some environments (corporate proxies, load balancers) block WebSocket upgrades. SSE (Server-Sent Events) works over standard HTTP and provides a reliable fallback for one-way event streaming.

### Implementation

```python
# apps/api/routers/events.py

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import asyncio

router = APIRouter()

@router.get("/api/jobs/{job_id}/events")
async def sse_events(job_id: str, request: Request, last_seq: int = 0):
    """SSE endpoint for real-time job events (fallback for WebSocket)."""
    
    async def event_generator():
        # Replay missed events
        if last_seq > 0:
            missed = await manager.replay_since(job_id, last_seq)
            for event in missed:
                yield f"data: {json.dumps(event)}\n\n"
        
        # Subscribe to new events
        pubsub = manager.redis.pubsub()
        await pubsub.subscribe(f"ws:{job_id}")
        
        try:
            while True:
                if await request.is_disconnected():
                    break
                
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message:
                    yield f"data: {message['data']}\n\n"
                
                # Heartbeat every 15s to keep connection alive
                yield ": heartbeat\n\n"
                await asyncio.sleep(0.1)
        finally:
            await pubsub.unsubscribe(f"ws:{job_id}")
            await pubsub.close()
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
```

---

## Event Types & Schema

### Unified Event Schema

All events across all channels follow the same envelope format:

```typescript
interface EventEnvelope {
    seq: number;           // Monotonic sequence number
    timestamp: string;     // ISO 8601 UTC
    data: {
        type: EventType;   // Discriminated union tag
        [key: string]: any;
    };
}

type EventType =
    // Lobby events
    | "contributor_joined"
    | "contributor_ready"
    | "contributor_status_change"
    | "contributor_disconnected"
    | "contributor_left"
    | "lobby_state_change"

    // Task events
    | "task_created"
    | "task_claimed"
    | "task_completed"
    | "task_released"
    | "task_updated"
    | "task_verification_update"

    // Merge events
    | "merge_enqueued"
    | "merge_processing"
    | "merge_completed"
    | "merge_conflict"

    // Chat events
    | "new_message"

    // Log events (separate channel)
    | "agent_log_line"

    // System events
    | "job_status_change"
    | "heartbeat";
```

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/websocket.py` | **REWRITE** | Redis-backed ConnectionManager |
| `apps/api/routers/events.py` | **NEW** | SSE fallback endpoint |
| `apps/api/main.py` | **MODIFY** | Initialize Redis in lifespan |
| `apps/api/routers/logs.py` | **MODIFY** | Use unified manager instead of separate channels dict |
| `apps/web/lib/ws-client.ts` | **NEW** | Reconnecting WebSocket client |

### Environment Variables

```bash
# Required for v2
REDIS_URL=redis://localhost:6379  # Already in docker-compose
```
