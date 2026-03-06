# Contributing to Swarmbuild

Thanks for your interest in contributing! This guide will help you get started.

## Getting Set Up

1. **Fork** the repo and clone your fork
2. Follow the [Getting Started](README.md#getting-started) guide to set up your local environment
3. Create a new branch for your work: `git checkout -b feature/my-feature`

## Project Structure

- `apps/api/` — FastAPI backend (Python)
- `apps/web/` — Next.js frontend (TypeScript)
- `packages/cli/` — Agent orchestrator CLI (Node.js)
- `packages/github-client/` — GitHub repo provisioning (Python)

## Development Workflow

### Running locally

```bash
# Install all dependencies
npm install
cd apps/api && pip install -r requirements.txt && cd ../..

# Start both servers
npm run dev:all
```

### Making changes

- **Backend changes**: Edit files in `apps/api/`. The server auto-reloads with `--reload`.
- **Frontend changes**: Edit files in `apps/web/`. Next.js hot-reloads automatically.
- **CLI changes**: Edit files in `packages/cli/src/`.

### Code style

- **Python**: Follow existing patterns in the codebase. Use type hints where possible.
- **TypeScript/React**: Follow existing component patterns. Use functional components with hooks.
- **CSS**: Use the existing CSS variables defined in `apps/web/app/globals.css`. Prefer inline styles or existing utility classes over adding new CSS files.
- **No unnecessary comments**: Don't add or remove comments unless the change specifically requires it.

## What to Work On

### Good first contributions

- Bug fixes
- Documentation improvements
- UI polish and accessibility
- Test coverage
- Error handling improvements

### Larger contributions

For larger features, please **open an issue first** to discuss the approach before writing code. This helps avoid wasted effort and ensures the change aligns with the project direction.

## Submitting a Pull Request

1. Make sure your code works locally
2. Keep PRs focused — one feature or fix per PR
3. Write a clear description of what changed and why
4. If your change affects the UI, include a screenshot
5. Make sure the frontend builds without errors: `cd apps/web && npx next build`

## Reporting Bugs

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser/OS if it's a frontend issue
- Any relevant error messages or logs

## Questions?

Open a discussion on GitHub or reach out via issues. We're happy to help you get started.
