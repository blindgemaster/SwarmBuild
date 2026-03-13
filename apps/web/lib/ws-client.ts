/**
 * ReconnectingWebSocket — Auto-reconnecting WebSocket client with
 * exponential backoff and event sequence tracking for replay.
 *
 * Reference: The Engineering/07-REALTIME-INFRA.md §Connection Recovery
 */

type MessageHandler = (data: Record<string, unknown>) => void;

export class ReconnectingWebSocket {
    private ws: WebSocket | null = null;
    private lastSeq = 0;
    private reconnectDelay = 1000;
    private maxReconnectDelay = 30000;
    private url: string;
    private onMessage: MessageHandler;
    private closed = false;

    constructor(url: string, onMessage: MessageHandler) {
        this.url = url;
        this.onMessage = onMessage;
        this.connect();
    }

    private connect() {
        if (this.closed) return;

        const connectUrl = this.lastSeq > 0
            ? `${this.url}?last_seq=${this.lastSeq}`
            : this.url;

        try {
            this.ws = new WebSocket(connectUrl);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log("[ws] Connected");
            this.reconnectDelay = 1000; // Reset backoff
        };

        this.ws.onmessage = (event: MessageEvent) => {
            try {
                const envelope = JSON.parse(event.data);
                if (envelope.seq) {
                    this.lastSeq = envelope.seq;
                }
                this.onMessage(envelope.data || envelope);
            } catch {
                // Non-JSON message (e.g. heartbeat comment)
            }
        };

        this.ws.onclose = () => {
            if (this.closed) return;
            console.log(`[ws] Disconnected. Reconnecting in ${this.reconnectDelay}ms...`);
            this.scheduleReconnect();
        };

        this.ws.onerror = () => {
            // onclose will fire after onerror
        };
    }

    private scheduleReconnect() {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }

    close() {
        this.closed = true;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }
}
