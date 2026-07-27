# WebPilot Studio

WebPilot Studio is an independently implemented agentic web IDE for creating,
running, diagnosing, and verifying React projects in the browser. The public
Beta is designed for deployment on Vercel.

## Independent Implementation

This repository contains only the new WebPilot Studio application. The sibling
`../web-cursor/` repository is a read-only behavioral and architectural
reference:

- It is not a dependency, package, submodule, or build input.
- Its source code and Git history must never be committed to this repository.
- Features are implemented independently from the product requirements and
  observed behavior.

Workspace planning files such as `../TECHNICAL_DESIGN.md` and `../tasks.md` also
remain outside this Git repository.

## Requirements

- Node.js 22.x
- pnpm 11.9.0

Use Corepack when pnpm is not already available:

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
```

## Local Development

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`.

All environment variables are optional during the M0 foundation milestone.
Configured values are validated with Zod at server startup. Private variables
are defined in `infrastructure/env/server.ts`; only `NEXT_PUBLIC_*` values may
be imported into browser code through `infrastructure/env/public.ts`.

## Commands

```bash
pnpm dev          # Start the Next.js development server
pnpm build        # Create a production build
pnpm start        # Run the production build
pnpm lint         # Run ESLint
pnpm typecheck    # Run TypeScript without emitting files
pnpm format       # Format tracked source and configuration files
pnpm format:check # Verify formatting
pnpm test         # Run Vitest and Testing Library tests
pnpm test:watch   # Run unit tests in watch mode
pnpm test:e2e     # Run Playwright browser tests
```

Install the Playwright Chromium binary once on a new machine:

```bash
pnpm exec playwright install chromium
```

## Vercel Preview Verification

`vercel.json` uses `pnpm vercel-build` as the deployment build command. Every
Vercel build must therefore pass lint, TypeScript, Vitest, and the production
Next.js build before a deployment can become ready.

The `Vercel Preview Smoke` GitHub workflow listens for successful Preview
deployment statuses and then runs Playwright against the remote deployment:

- verifies the deployed COOP/COEP response headers;
- verifies `window.crossOriginIsolated`;
- boots the real WebContainer and waits for its iframe preview.

Run the same remote smoke manually with:

```bash
PLAYWRIGHT_BASE_URL=https://your-preview.vercel.app \
  pnpm test:e2e:preview
```

If Vercel Deployment Protection is enabled, configure the optional
`VERCEL_AUTOMATION_BYPASS_SECRET` GitHub Actions secret. The test exchanges the
secret for a same-site bypass cookie before loading the application.

## Infrastructure Verification

After linking the Vercel project and its Development environment, run:

```bash
vercel env run -- pnpm test:infrastructure
```

This performs a read-only Neon Postgres probe and an upload/delete cycle against
the private Vercel Blob store. See `docs/infrastructure.md` for the environment
boundaries and cleanup behavior.

## Architecture Boundaries

- `app/`: Next.js routes, layouts, API handlers, and runtime entry points.
- `components/`: UI primitives and product-surface React components.
- `domains/`: provider-independent business rules and contracts.
- `infrastructure/`: database, storage, queue, LLM, and platform adapters.
- `messages/`: Chinese and English locale dictionaries.
- `tests/`: unit, contract, integration, and browser tests.
- `docs/`: repository-local decisions and operating notes.

The project is delivered as independently deployable vertical milestones. Keep
framework and provider concerns at the edges so domain behavior can be tested
without Next.js or external services.
