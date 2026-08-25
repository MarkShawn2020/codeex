# ADR-0001: Use a single-surface Codeex wrapper

## Status

Accepted

## Context

Codeex currently presents a native plugin-launcher window and then starts a
separate, modified private clone of the official Codex Desktop application.
The runtime works, but the product exposes two application layers and feels
neither like native injection nor like one complete wrapper.

The desired product has these functional requirements:

- opening Codeex must immediately open the complete official Codex UI;
- tasks, Agents, code operations, Skills, MCP, and `~/.codex` history must work;
- local plugins such as Lovinsp and Daemonize must remain independently managed;
- plugin management must be secondary to the Codex UI, not the first screen;
- the official `/Applications/ChatGPT.app` must remain usable and untouched.

The relevant non-functional requirements are:

- preserve active tasks and never force-quit another Codex instance for setup;
- survive official app updates through an explicit rebuild from the new version;
- retain localhost-only, authenticated plugin control;
- avoid claiming OpenAI signing identity or entitlements after modification;
- present one Codeex application surface and one Dock identity.

The official app is notarized with OpenAI's Developer ID and includes OpenAI
Team-scoped App Groups, Keychain groups, push notification entitlement, and an
`ElectronAsarIntegrity` hash. Lovinsp additionally needs production renderer
instrumentation before the modules execute so inspected DOM nodes carry source
locations. Modifying the official bundle invalidates its signature and update
contract; CDP-only runtime injection cannot provide equivalent source metadata.

## Decision

Codeex will be distributed as a signed launcher bundle with a separate Codeex
bundle identifier. It does not redistribute official application binaries. On
first launch it creates a private, writable runtime from the exact official
production app already installed on the user's Mac. Its main visible surface is
the complete Codex renderer.

A small native supervisor remains inside the same `Codeex.app` bundle, but it
does not show a launcher window. It starts the managed Electron runtime
immediately, owns its lifecycle, and exposes a menu-bar item for the optional
plugin center. The plugin center is a secondary window of Codeex. The
supervisor and Electron runtime use distinct LaunchServices identities; parent
application identity variables are never inherited by the runtime. Background
startup, health checks, status streaming, and restarts must not activate either
application. Foreground activation is reserved for an explicit user action.

The canonical official `/Applications/ChatGPT.app` is read-only input. It is
never patched in place. Generated production sources and the private runtime
live below `~/Library/Application Support/Codeex/Runtime`. Codeex keeps using
`~/.codex` for task data while using its own Electron profile and bundle
identifier.

## Consequences

### Positive

- Opening Codeex goes directly to the full Codex experience.
- There is no standalone launcher window or visible second application layer.
- Plugin management remains available without replacing the primary UI.
- Official ChatGPT keeps its signature, updates, entitlements, and fallback role.
- The wrapper can be rebuilt deterministically from each official production update.

### Negative

- The first launch must locally prepare a private copy of official production resources.
- The wrapper cannot inherit OpenAI Team-scoped entitlements after ad-hoc signing.
- Official updates require rebuilding Codeex before the new version is used.
- Plugin changes that alter renderer code require a managed Codeex restart.

### Neutral

- Task history remains in `~/.codex`; Electron browser state remains isolated.
- The signed native supervisor and locally prepared Electron renderer are separate processes presented as one product.

## Alternatives Considered

### Patch the official ChatGPT app in place

Rejected. Any renderer or `app.asar` modification invalidates the notarized
signature and Electron integrity hash. Re-signing cannot reproduce OpenAI's Team
entitlements, and the official updater can overwrite the changes.

### Inject only through CDP at launch

Rejected for the complete Lovinsp contract. CDP can add a runtime script, but
it cannot reliably rewrite every production module before evaluation to add
bundle source locations. Request interception for Electron's private `app://`
resources would also be version-sensitive.

### Keep the current launcher plus private runtime

Deprecated. It is operationally workable but exposes two product layers and
does not meet the one-surface requirement.

## Failure Modes and Mitigations

- If the wrapper build fails, leave the installed Codeex bundle untouched.
- If the official version changes, stage and verify the new wrapper before replacement.
- If a plugin rebuild fails, keep the last signed runtime and report the exact error.
- If Codeex exits, do not terminate an independent official ChatGPT instance.
- If the native supervisor exits or is replaced, its control server detects the
  lost parent and stops the managed runtime instead of becoming an orphan.
- If historical task paths retain an old project root, preserve the compatibility symlink.

## References

- Local official app signature and entitlement inspection
- Codeex production smoke verification
- `scripts/prepare-codex.mjs`
- `scripts/instrument-production-bundle.mjs`
