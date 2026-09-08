FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS test
RUN npm test

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY public ./public
# Keep the existing application UID for mounted file ownership.
RUN addgroup -S -g 101 app && adduser -S -u 100 app -G app
RUN mkdir -p /app/inbound && chown -R app:app /app
USER app
EXPOSE 3160
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3160/healthz || exit 1
CMD ["node", "dist/server.js"]
