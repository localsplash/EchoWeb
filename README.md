# EchoMessagingService

TypeScript/Express proof-of-concept for Bandwidth SMS send/receive.

## Endpoints
- `GET /` (basic sendMessage UI)
- `GET /healthz`
- `POST /callbacks/inbound/messaging`
- `GET /message/list`
- `GET /message/open?id=<messageId>`
- `POST /sendMessage`
- `GET /api-docs`

## Local Run
```bash
cp .env.example .env
# fill environment values
npm install
npm run dev
```

## Build & Run
```bash
npm run build
npm start
```

## Docker
```bash
docker compose up -d --build
```

## Required Environment
- BANDWIDTH_ACCOUNT_ID
- BANDWIDTH_API_TOKEN
- BANDWIDTH_API_SECRET
- BANDWIDTH_APPLICATION_ID

## Example sendMessage
```bash
curl -X POST http://localhost:3000/sendMessage \
  -H 'content-type: application/json' \
  -d '{"from":"+17149799911","to":"+17146120126","text":"Echo is alive; from Clawdy"}'
```
