# Contributing to Conduit

Thank you for your interest in contributing to Conduit!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/conduit.git`
3. Install dependencies: `npm ci`
4. Copy `.env.example` to `.env` and fill in your values
5. Start databases: `docker compose up -d`
6. Run migrations: `psql -f docker/postgres/init.sql`
7. Build: `npx tsc --skipLibCheck`
8. Start: `node dist/src/server.js`

## Development

```bash
# Type check
npx tsc --skipLibCheck

# Run the server
node dist/src/server.js

# Health check
curl http://localhost:4000/health
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what and why
- Ensure `npx tsc --skipLibCheck` passes
- Follow existing code patterns and naming conventions

## Knowledge Packs

Want to contribute a knowledge pack? See the [Knowledge Pack Spec](docs/knowledge-pack-spec.md) and the [knowledge-packs](https://github.com/datakailabs/knowledge-packs) repository.

## License

By contributing to Conduit, you agree that your contributions will be licensed under the AGPL-3.0 license.
