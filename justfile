set shell := ["bash", "-euo", "pipefail", "-c"]

bootstrap:
    npm install

migrate:
    npm run migrate

dev:
    npm run dev

status:
    npm run status

incus-image:
    npm run incus:image

check:
    npm run typecheck
    npm test
    git diff --check

build:
    npm run build

# Build the immutable Nix package used by production.
nix-build:
    nix build

# Validate the flake and its package metadata.
nix-check:
    nix flake check
