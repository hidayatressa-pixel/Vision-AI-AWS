# Vision Station AWS frontend

An isolated React/Vite frontend for the AWS repository. It implements the requested flow:

1. Welcome screen
2. Initial setup screen for the API Gateway analyzer endpoint

This frontend is deliberately kept under `frontend/`; it does not overwrite or import the production UI in `Vision-Ai-Prod`, and it does not modify the Lambda/SAM analyzer.

## Run locally

```bash
cd frontend
npm install
npm run dev
```

Build verification:

```bash
npm run build
```

Optional environment values can be copied from `.env.example` to `.env.local`. The analyzer endpoint is saved in browser local storage by the setup screen.

## Important security and deployment notes

- This is a public demo setup screen, not an authenticated engineering portal. Do not enter confidential data or credentials.
- Saving an API URL does not deploy or test AWS resources. The backend remains the existing SAM/Lambda/API Gateway stack.
- This change adds a frontend source project only. It does not configure hosting or claim that a live AWS website/API exists.
