FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @mylar/web

FROM node:26-slim
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/mylar.sqlite WEB_DIST=/app/web-dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w @mylar/api
COPY packages/shared/src packages/shared/src
COPY packages/api/src packages/api/src
COPY --from=build /app/packages/web/dist ./web-dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/api/src/server.ts"]
