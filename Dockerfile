# 构建网页
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 运行：后端零依赖，不需要 npm install
FROM node:24-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/nota.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
