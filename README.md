# CF Migrate — Codefresh to GitHub Actions Migration System

Intelligent migration system that analyzes Codefresh pipelines and generates equivalent GitHub Actions workflows, built as a VS Code extension powered by GitHub Copilot.

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9.0.0
- **VS Code** ≥ 1.90.0 (for extension development)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build the VS Code extension
cd packages/extension && node esbuild.config.mjs

# Run in watch mode
pnpm watch
```

## Project Structure

```
cf-migrate/
├── packages/
│   ├── core/       # Core types, config, state machine, ledger
│   ├── kb/         # Knowledge base (patterns, snippets, templates)
│   ├── llm/        # LLM client, prompts, provider integrations
│   ├── agents/     # AI agents (analysis, discovery, planning, generation)
│   └── extension/  # VS Code extension (this is the main artifact)
├── kb-default/     # Default knowledge base content
│   ├── patterns/   # Migration pattern definitions
│   ├── snippets/   # Reusable workflow snippets
│   └── templates/ # Full workflow templates
└── prompt-templates/  # AI agent prompt templates
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages (TypeScript) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm watch` | Watch mode for all packages |
| `pnpm clean` | Clean build artifacts |

## Extension Development

The extension is built with esbuild into a single bundle:

```bash
cd packages/extension
node esbuild.config.mjs        # Production build
node esbuild.config.mjs --watch # Watch mode
```

Output: `packages/extension/dist/extension.js`

### Loading the Extension in VS Code

1. Build the extension: `node esbuild.config.mjs`
2. Press `F5` in VS Code to launch the Extension Development Host
3. Or use `Debug: Start Extension` from the Command Palette

## Architecture

- **Core** — Shared types, config management, event bus, state machine
- **KB** — Knowledge base with patterns/snippets/templates for migrations
- **LLM** — Provider-agnostic LLM client with prompt management
- **Agents** — Specialized AI agents for analysis, discovery, planning, generation
- **Extension** — VS Code integration (codelens, hovers, commands, webviews)

## Knowledge Base

The system includes built-in migration patterns:

| Pattern | Description |
|---------|-------------|
| `build-push-to-action` | Build & push to GitHub Actions |
| `cf-export-to-output` | Codefresh exports to Actions outputs |
| `composition-to-services` | Compositions to container services |
| `context-to-secrets` | Contexts to GitHub Secrets |
| `deploy-to-environment` | Environment deployments |
| `freestyle-to-run` | Freestyle steps to run steps |
| `hooks-to-always-steps` | Hooks to `if: always()` |
| `parallel-to-matrix` | Parallel steps to matrix strategy |
| `parallel-to-sibling-jobs` | Parallel jobs to sibling jobs |
| `shared-volume-to-artifact` | Shared volumes to artifacts |
| `triggers-to-on-events` | Triggers to `on:` events |

## Tech Stack

- **TypeScript** — Type-safe codebase
- **pnpm** — Monorepo package manager
- **esbuild** — Fast bundler for extension
- **Zod** — Runtime validation
- **VS Code API** — Extension platform