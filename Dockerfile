# 🎯 后端依赖阶段 (与前端构建并行)
FROM node:24-alpine AS backend-deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# 🎯 前端构建阶段 (与后端依赖并行)
FROM node:24-alpine AS frontend-builder

WORKDIR /app/web/admin-spa

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY web/admin-spa/package.json web/admin-spa/pnpm-lock.yaml ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY web/admin-spa/ ./

RUN pnpm run build

# 🐳 主应用阶段
FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/SunSeekerX/claude-relay-service"
LABEL org.opencontainers.image.description="Claude Code API Relay Service (SunSeekerX maintained fork)"

RUN apk add --no-cache \
    curl \
    dumb-init \
    sed \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

COPY --from=backend-deps /app/node_modules ./node_modules

COPY . .

COPY --from=frontend-builder /app/web/admin-spa/dist /app/web/admin-spa/dist

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p logs data temp

RUN if [ ! -f "/app/config/config.js" ] && [ -f "/app/config/config.example.js" ]; then \
        cp /app/config/config.example.js /app/config/config.js; \
    fi

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
