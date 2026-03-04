import axios from "axios";

export class SwarmbuildAPI {
    constructor(relayUrl, devToken = null) {
        this.relayUrl = relayUrl;
        this.client = axios.create({ baseURL: relayUrl });
        this.devToken = devToken;
        this.workerToken = null;
    }

    // --- Helper ---

    async _fetchWithRetry(method, url, data = null, config = {}, maxRetries = 3) {
        let attempt = 0;
        while (attempt < maxRetries) {
            try {
                if (method === 'get') {
                    return await this.client.get(url, config);
                } else {
                    return await this.client[method](url, data, config);
                }
            } catch (err) {
                attempt++;
                const isNetworkError = !err.response && (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED');
                if (isNetworkError && attempt < maxRetries) {
                    console.log(`[swarmbuild] ⚠️ Network error (${err.code}). Retrying in ${attempt}s...`);
                    await new Promise(r => setTimeout(r, attempt * 1000));
                } else {
                    throw err;
                }
            }
        }
    }

    // --- Registration Phase ---

    async register(jobId, role) {
        this.jobId = jobId;
        console.log(`[DEBUG] POSTing to /api/jobs/${jobId}/contribute with role ${role}`);
        const res = await this._fetchWithRetry('post',
            `/api/jobs/${jobId}/contribute`,
            { role },
            { headers: { Authorization: `Bearer ${this.devToken}` } }
        );
        this.workerToken = res.data.worker_token;
        return res.data;
    }

    async setReady(jobId, isReady) {
        const res = await this._fetchWithRetry('post',
            `/api/jobs/${jobId}/ready`,
            { is_ready: isReady, worker_token: this.workerToken },
            { headers: { Authorization: `Bearer ${this.devToken}` } }
        );
        return res.data;
    }

    // --- Worker Phase (Authenticated via worker_token) ---

    async getJobInfo() {
        const res = await this._fetchWithRetry('get', `/api/worker/job/${this.workerToken}`);
        return res.data;
    }

    async getTasks() {
        const res = await this._fetchWithRetry('get', `/api/${this.workerToken}/tasks`);
        return res.data.tasks;
    }

    async claimTask(taskId) {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks/${taskId}/claim`);
        return res.data;
    }

    async completeTask(taskId, status) {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks/${taskId}/complete`, { status });
        return res.data;
    }

    async createTasks(tasks) {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks`, { tasks });
        return res.data;
    }

    async getMessages() {
        const res = await this._fetchWithRetry('get', `/api/worker/${this.workerToken}/messages`);
        return res.data.messages;
    }

    async broadcastMessage(content) {
        const res = await this._fetchWithRetry('post', `/api/worker/${this.workerToken}/messages`, { content });
        return res.data;
    }

    async publishLog(content) {
        // Send raw text to the log relay endpoint
        const res = await this._fetchWithRetry('post', `/api/logs/${this.workerToken}`, content, {
            headers: { 'Content-Type': 'text/plain' }
        });
        return res.data;
    }
}
