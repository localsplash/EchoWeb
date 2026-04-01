# EchoWeb

Frontend web app for Echo messaging.

## Architecture
- **EchoWeb** = login/session + browser UI
- **EchoService** = mid-tier API, Bandwidth integration, webhooks, and database access
- **Production EchoService URL** = `https://io.echo.wisp.net`

EchoWeb should not connect directly to MySQL.
All data I/O flows through `ECHO_SERVICE_BASE_URL`.

## Local Run
```bash
cp .env.example .env
npm install
npm run dev
```

## Required Environment
- `ECHO_SERVICE_BASE_URL`

## Dev Model
For local development on Windows/macOS/Linux, run EchoWeb locally and point it at the shared mid-tier:

- `ECHO_SERVICE_BASE_URL=https://io.echo.wisp.net`

That lets a remote developer run the UI without needing MySQL or the Bandwidth webhook stack locally.
