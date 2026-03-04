"""
WebSocket Connection Manager for Swarmbuild Lobby
"""
import json
from typing import Dict, List
from fastapi import WebSocket

class ConnectionManager:
    def __init__(self):
        # Maps job_id to a list of active WebSocket connections
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, job_id: str):
        await websocket.accept()
        if job_id not in self.active_connections:
            self.active_connections[job_id] = []
        self.active_connections[job_id].append(websocket)

    def disconnect(self, websocket: WebSocket, job_id: str):
        if job_id in self.active_connections:
            try:
                self.active_connections[job_id].remove(websocket)
                if not self.active_connections[job_id]:
                    del self.active_connections[job_id]
            except ValueError:
                pass

    async def broadcast(self, job_id: str, message: dict):
        if job_id in self.active_connections:
            # We convert to JSON string here to simplify frontend parsing if needed, 
            # though send_json does it automatically.
            disconnected = []
            for connection in self.active_connections[job_id]:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(connection)
            
            # Cleanup dead connections
            for conn in disconnected:
                self.disconnect(conn, job_id)

manager = ConnectionManager()
