# syntax=docker/dockerfile:1
FROM node:20.20.2-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY client/ ./
RUN npm run build

FROM node:20.20.2-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./

FROM node:20.20.2-alpine AS runner
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=server-builder /app/server ./server
COPY --chown=node:node --from=client-builder /app/client/dist ./client/dist
COPY --chown=node:node shared ./shared
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
