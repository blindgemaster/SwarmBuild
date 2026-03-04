FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    python3-pip \
    bash \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Python deps
RUN pip3 install requests anthropic

# Install Claude CLI (placeholder — update when official CLI is available)
# RUN npm install -g @anthropic-ai/claude-cli

# Copy worker files
COPY worker.py /worker.py
COPY agent_loop.sh /agent_loop.sh
RUN chmod +x /agent_loop.sh

# Git config (agents need this to commit)
RUN git config --global user.email "agent@swarmforge.io" && \
    git config --global user.name "Swarmforge Agent"

WORKDIR /workspace

ENTRYPOINT ["python3", "/worker.py"]
