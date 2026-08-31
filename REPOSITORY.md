# dsh-s2s repository

**dsh-s2s is a trimmed fork of [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a) (MIT)** — same-host session-to-session interconnection for the DeepSeek Harness, with session-lifecycle support on the roadmap. Build artifacts are not tracked; `lib/` and `node_modules/` remain ignored.

## Package

| Package | Location | Role |
|---|---|---|
| `dsh-s2s` | repository root | Same-host S2S mesh (hub transport and storage, serial injection), model tools, and the session-lifecycle modules (mailbox / resume / budget) added by this fork. |

All connection-management, protocol, and injection core code is inherited from the upstream `@dpskh/a2a` snapshot (see `vendor-base` tag); the trimmed fork removes the browser package, the command surface, and the browser test stubs.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
```
