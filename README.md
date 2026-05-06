# Geulbat CI Mirror

This repository is a sanitized validation-only mirror of a private development repository.

No open-source license is granted. All rights are reserved by the copyright holder.

This mirror exists only to run public CI on sanitized source snapshots. Do not treat this repository as the development source of truth. Do not redistribute, reuse, modify, publish, or derive from this code without explicit written permission.

## Source Of Truth

- The private/local repository remains the source of truth for development, review, and merge decisions.
- This public repository is generated from sanitized exports only.
- Changes flow one way: private/local source to public CI mirror.
- Do not send changes from this mirror back into the private repository.

## Safety Rules

Sanitized exports must remove secrets, credentials, personal data, local paths, private audit outputs, and non-public git history before they are pushed here.

If sensitive material is ever found in this mirror, treat it as exposed, remove it immediately, rotate the affected secret if applicable, and rebuild the mirror from a clean sanitized export.
