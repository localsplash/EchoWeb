FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY public ./public
# uid 100 is a platform invariant, not a coincidence.
#
# identity writes its bootstrap file (/data/config.json) mode 0600 as uid 100,
# and a single-host install mounts that volume read-only into this container.
# `adduser -S` without -u takes whatever system uid is free, which is how this
# and identity came to match by luck — and how they would silently stop
# matching on a base-image bump. Pinned here, in identity, and in EchoService.
RUN addgroup -S -g 101 app && adduser -S -u 100 app -G app
RUN mkdir -p /app/inbound /data && chown -R app:app /app /data
USER app
EXPOSE 3160
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3160/healthz || exit 1
CMD ["node", "dist/server.js"]
