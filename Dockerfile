# Gleaner — multi-arch (linux/arm64 for Pi 5, linux/amd64 for dev)
# Build & push for Umbrel:  docker buildx build --platform linux/arm64,linux/amd64 -t ghcr.io/<you>/gleaner:0.1.0 --push .

FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG RMAPI_VERSION=v0.0.35
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv libcairo2 fonts-dejavu-core ca-certificates curl openssh-client tar \
    && rm -rf /var/lib/apt/lists/*
# Renderer: rmc (.rm v6 → SVG) + cairosvg (SVG → PNG), pinned. rmscene is rmc's .rm parser; pin it too.
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir rmc==0.3.0 rmscene==0.6.1 cairosvg==2.7.1
# Cloud client: ddvk/rmapi (maintained fork), pinned release binary
RUN curl -fsSL "https://github.com/ddvk/rmapi/releases/download/${RMAPI_VERSION}/rmapi-linux-${TARGETARCH}.tar.gz" \
      | tar xz -C /usr/local/bin rmapi && chmod +x /usr/local/bin/rmapi
ENV PATH=/opt/py/bin:$PATH NODE_ENV=production GLEANER_DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY py ./py
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3717
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fs http://localhost:3717/health || exit 1
CMD ["node", "src/index.js"]
