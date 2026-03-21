import axios from "axios";

export class SwarmbuildAPI {
    constructor(relayUrl, devToken = null) {
        this.relayUrl = relayUrl;
        this.client = axios.create({ baseURL: relayUrl, timeout: 30_000 });
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
                const isNetworkError = !err.response && (
                    err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' ||
                    err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED' ||
                    err.code === 'ETIMEDOUT'
                );
                const isRetryableStatus = err.response && (
                    err.response.status === 503 || err.response.status === 429 ||
                    err.response.status === 502 || err.response.status === 504
                );
                if ((isNetworkError || isRetryableStatus) && attempt < maxRetries) {
                    const reason = isNetworkError ? err.code : `HTTP ${err.response.status}`;
                    console.log(`[swarmbuild] ⚠️ ${reason}. Retrying in ${attempt}s...`);
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

    async completeTask(taskId, status, tokensUsed = 0) {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks/${taskId}/complete`, { status, tokens_used: tokensUsed });
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

    // --- v2: Heartbeat ---

    async heartbeat({ agents_running = 1, tokens_used = 0, current_task_id = null, status = "idle", sessions_run = 0, commits_pushed = 0 } = {}) {
        const res = await this._fetchWithRetry('post', `/api/worker/heartbeat/${this.workerToken}`, {
            agents_running, tokens_used, current_task_id, status, sessions_run, commits_pushed,
        });
        return res.data;
    }

    // --- v2: Graceful Shutdown ---

    async releaseAllMyTasks() {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks/release-all`);
        return res.data;
    }

    async workerComplete(status, message = "") {
        const res = await this._fetchWithRetry('post', `/api/worker/complete/${this.workerToken}`, { status, message });
        return res.data;
    }

    // --- v2: Merge Queue ---

    async enqueueMerge(taskId, branchName, commitSha = null) {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/merge/enqueue`, {
            task_id: taskId, branch_name: branchName, commit_sha: commitSha,
        });
        return res.data;
    }

    // --- v2: Task Attempts ---

    async getTaskAttempts(taskId) {
        const res = await this._fetchWithRetry('get', `/api/${this.workerToken}/tasks/${taskId}/attempts`);
        return res.data.attempts;
    }

    // --- v2.3: Task Cancellation ---

    async cancelTask(taskId, reason = "") {
        const res = await this._fetchWithRetry('post', `/api/${this.workerToken}/tasks/${taskId}/cancel`, { reason });
        return res.data;
    }
}
