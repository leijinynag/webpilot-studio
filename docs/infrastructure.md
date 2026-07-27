# Infrastructure Verification

M0 uses three separate Vercel environments:

- Development values are pulled into the ignored `.env.local` file.
- Preview values are attached to branch and pull request deployments.
- Production values are only exposed to production deployments.

The Neon database and private Vercel Blob store are connected to all three
environments. Provider credentials remain server-only and must never use a
`NEXT_PUBLIC_` prefix.

Run the live health checks with the linked Vercel Development environment:

```bash
vercel env run -- pnpm test:infrastructure
```

The database check only executes `SELECT 1`. The Blob check uploads a uniquely
named private text object and removes it in a `finally` block. These checks are
deliberately command-only and are not exposed as public application routes.
