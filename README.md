# WebPilot Studio

WebPilot Studio is an independently implemented agentic web IDE for creating,
running, diagnosing, and verifying React projects in the browser.

The project is inspired by the product behavior of Web Cursor. The reference
repository is used only for study and does not participate in this project's
build or runtime.

## Requirements

- Node.js 20.9 or newer
- pnpm 11.9.0

## Development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Architecture

The implementation follows the technical design in the workspace root and is
developed as independently deployable vertical milestones. This repository
contains the new application only; `../web-cursor/` remains a read-only
behavioral reference.
