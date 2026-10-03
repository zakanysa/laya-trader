# Laya Trader — web

Next.js (App Router, TypeScript, CSS Modules — no Tailwind) frontend for Laya Trader (inherited from jev-trader):
one AI trade decision every Monad block. It renders the original directional bot's events; the maker strategy streams its own (`event: maker`), which it does not show yet.

## Run

```bash
export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
bun install
bun run dev -p 3001   # http://localhost:3001 (the bot itself serves on 3000)
bun run build
```

## Config

Copy `.env.example` to `.env.local`. `NEXT_PUBLIC_API_URL` points at the backend
(default `http://localhost:3000`, the bot's own server); the app opens an
EventSource on `$NEXT_PUBLIC_API_URL/events`.

## Layout

- `src/lib/types.ts` — wire types (`BlockEvent`, `Decision`, `Fill`, `Meta`, …)
- `src/lib/useFeed.ts` — SSE hook: snapshot / block / fill / ping, 1000-event
  window, 1s→10s reconnect backoff, `connection` state, `avgLatencyMs`
- `src/lib/useUptime.ts` — `useUptime(startedAt)` → ticking `"hh:mm:ss"`
- `src/lib/format.ts` — number/address/tx formatting
- `src/app/globals.css` — design tokens, `pulse`/`breathe` keyframes, `.card`
- `src/components/<Name>/<Name>.tsx` — UI components (one folder each)
