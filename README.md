# Geulbat

This repository is a sanitized, runnable public snapshot of Geulbat generated from private/local source.

The source is available under the MIT License. See `LICENSE`.

## Prerequisites

- Node.js 24 or newer
- npm

## Install and verify

```bash
npm ci
npm run check
npm run build
```

## Run locally

Start the daemon and web shell in separate terminals:

```bash
npm run dev -w apps/daemon
```

```bash
npm run dev -w apps/web-shell
```

Provider credentials and tokens are not included. Complete provider sign-in on your own machine; runtime credentials remain local to that machine.

This public repository keeps only `main` and is not the development source of truth. Fixes happen in the private/local source and are exported again as a sanitized snapshot.
