# ⛏️ TON Tap Arena

A Telegram Mini App tap-to-earn game — tap to mine COIN, connect a TON wallet, climb the weekly
leaderboard, invite friends, buy cosmetic assets that carry real gameplay effects, and cash out
once you clear the withdrawal gate.

Built with **React + Vite + tRPC + Drizzle/Postgres**, with **TON Connect 2.0** for wallet auth and
**Telegram Mini App `initData`** for account sign-in.

---

## Two builds, one codebase

| | Platform build (the real game) | GitHub Pages build (this repo's live site) |
|---|---|---|
| Command | `pnpm build` | `VITE_DEMO=1 VITE_BASE=/ton-tap-arena/ pnpm build:web` |
| Backend | Real tRPC API + Postgres | In-browser demo backend |
| Auth | Telegram `initData` verified server-side (HMAC-SHA256) | Local guest session |
| Wallet | Real TON Connect 2.0 `ton_proof` | Simulated connect |
| Payments | Real on-chain transfers built and sent | Orders recorded, not broadcast |

GitHub Pages serves **static files only** — there is no Node process, no database and no bot token
behind it. So the Pages build sets `VITE_DEMO=1`, which swaps the tRPC network link for
`client/src/demo/demo-backend.ts`: a faithful in-browser re-implementation of the API that reuses
the **same `shared/` rule modules** the server does (`settleTapBatch`, `quoteWithdrawal`,
`tierEffects`, `resolveConfig`). The demo therefore cannot drift from the real game rules — it just
cannot touch a chain or a secret.

The Telegram Mini App runs the **platform build**, which is the one with real authentication and
real payments.

---

## Features

- **Tap-to-mine** — energy cap with lazy regen, combo multiplier, 5 leagues, turbo/refill/recharge
  boosters, a 10-day streak ladder, and 4 passive-income mining rigs.
- **Real TON Connect 2.0** — nonce → wallet signature → server-side Ed25519 verification of a
  `ton_proof`, with the nonce burned so it cannot be replayed. A bare address is never trusted.
- **Telegram Mini App auth** — `initData` is validated server-side with HMAC-SHA256 against the bot
  token (which never leaves the server). No sign-up form inside Telegram.
- **Email/password + guest fallback** — so the game still works in a plain browser.
- **Weekly leaderboard** — real players ranked by coins mined this week, with your own rank pinned.
- **Referral engine** — invite rewards, a 4-rung ladder, and revenue share.
- **Asset shop** — 5 skins and 5 tap buttons across Common→Mythic, each with a **server-enforced**
  effect (tap power, energy cap, regen, combo, passive income). Higher tiers are strictly stronger.
- **Withdrawal gate** — 5 TON threshold, live progress, fee breakdown, and a button that stays
  disabled until the balance qualifies.
- **Watch-ads slot** — configurable ad unit, reward and daily limit (Adsgram-compatible).
- **Sound & music** — synthesised SFX and a looping theme, with a persistent mute toggle.

---

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in DATABASE_URL, JWT_SECRET, TELEGRAM_BOT_TOKEN
pnpm db:migrate
pnpm dev                  # API on :3001, web on :3000
```

### Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Session cookie signing key |
| `TELEGRAM_BOT_TOKEN` | **Server-side only.** Verifies Mini App `initData` via HMAC-SHA256 |
| `TELEGRAM_CLIENT_ID` / `TELEGRAM_CLIENT_SECRET` | Telegram app credentials (server-side) |

> **The bot token is a secret.** It is read only on the server, is never placed in the client
> config, and is never logged. `.env` is git-ignored — only `.env.example` is committed.

---

## Going live as a Telegram Mini App

1. **Set the Mini App URL.** In [@BotFather](https://t.me/BotFather): `/mybots` → your bot →
   **Bot Settings → Menu Button → Configure menu button**, and point it at the deployed game URL.
   Alternatively `/newapp` to register a Mini App with its own short name.
2. **Set the domain.** BotFather → **Bot Settings → Domain** — add the HTTPS domain the game is
   served from. Telegram requires HTTPS.
3. **Set the commands.** `/setcommands` → `start - Open TON Tap Arena`.
4. **Deploy the platform build** somewhere with a Node runtime and a Postgres database, and set the
   environment variables above.
5. **Open the bot and tap Start** — the game launches as a Mini App and the player is signed in
   automatically from `initData`.

### Treasury

The canonical treasury identifier is the EVM address `0x24170ba189134922d1606c9C0F13D75d1B40CA35`.
TON addresses are 32-byte, so a **TON-format counterpart** must be configured before the withdrawal
rail can broadcast. Until it is set, the server refuses to send rather than guess.

---

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — 143 tests
pnpm build       # client + server
```

The Telegram `initData` validator has dedicated tests covering a valid payload, a tampered payload,
a wrong-token signature, a stripped hash, an expired payload, and a future-dated payload.

---

## License

Provided as-is for the project owner.
