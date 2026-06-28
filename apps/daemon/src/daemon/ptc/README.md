# PTC Source Layout

This tree is organized by PTC layer first, then by lab domain. Keep new files
inside the narrowest owner directory instead of adding more top-level
`ptc/*.ts` files.

## Layers

- `runtime/` is the daemon-visible execution ingress. Composition, builtin
  tools, and agent callers should enter PTC through these owners and their
  contracts.
- `callback/` owns epoch callback channels and session callback bridges.
- `lab/` owns Docker lab capabilities and policy/domain owners.
- `shared/` contains PTC-local helpers that are deliberately shared across
  more than one layer.

## Lab Domains

- `lab/profile/` admits and projects PTC lab profiles.
- `lab/session/` owns Docker session lifecycle, create args, taint close, and
  host-root setup. It also composes package, network, and browser identity
  policy into the session reuse key, so it is a lab session owner rather than a
  pure low-level substrate.
- `lab/shell/` owns batch command execution and public session ids.
- `lab/browser/` owns browser policy and evidence families. Keep feature files
  in the narrow family directory:
  - `core/` for shared browser policy, session identity projection, request
    validation, URL grammar, output guards, fixed command execution, shared
    browser runtime command execution/cleanup, navigation attempt identity, and
    common result contracts.
  - `page-load-evidence/`, `text-evidence/`, and `user-url-navigation/` for the
    corresponding user-facing browser capabilities.
- `lab/packages/` owns package cache and install policy/result mapping.
- `lab/network/` owns local lab network policy and open-egress smoke telemetry.
- `lab/artifacts/` owns artifact workspace import into sandbox evidence.

## Direction

Preferred dependency flow:

```text
daemon composition / tools / agent
  -> runtime/*
  -> callback/* and lab/*
  -> shared/*
```

Cross-domain imports inside `lab/` should make ownership explicit. If a new
domain needs to share a shape with another domain, prefer moving that shape to
the owning domain or a narrow PTC-local shared module instead of creating a
barrel export.
