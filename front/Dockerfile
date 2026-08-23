FROM node:20-alpine

WORKDIR /app

# git: commit hash; curl/jq/unzip/bash: scripts/sync-all-marketing-sites.sh (optional dev sync)
RUN apk add --no-cache bash curl git jq unzip

# Copy package files and npm config (supply chain: pinned deps, no install scripts)
COPY package*.json .npmrc ./

# Install dependencies (--ignore-scripts: no lifecycle scripts, supply chain hardening)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Keep the executable entrypoint outside /app because the development bind mount
# replaces /app with the Windows checkout at runtime. Normalising it here makes
# the container reliable even when the host checkout uses CRLF line endings.
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && cp /app/docker-entrypoint.sh /usr/local/bin/pos-front-entrypoint \
    && chmod +x /usr/local/bin/pos-front-entrypoint

# Expose port
EXPOSE 80

# Use entrypoint to inject environment variables
ENTRYPOINT ["/usr/local/bin/pos-front-entrypoint"]

# Start dev server with host binding for Docker (no SSR in dev mode).
# --poll 2000: use polling for file watch so volume-mounted source changes are detected immediately
# (bind mounts often don't propagate inotify events; without this, edits on the host don't trigger rebuilds).
CMD ["npx", "ng", "serve", "--host", "0.0.0.0", "--port", "80", "--configuration", "development-no-ssr", "--poll", "2000"]
