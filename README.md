
## Charli3 Perp — Hack Submission

**What it does**
Oracle-indexed perps on Cardano Preprod + Midnight Preview. Fetches verified Charli3 ODV prices from on-chain C3AS UTxOs via Kupo, derives an L1 anchor digest, runs the Midnight Compact pipeline (order/matching/settlement/liquidation), then completes Cardano steps (Charli3 pull tx, settlement anchor). Default pair: **ADA-USD**. Includes a REST API + SPA (`perps-web`) and CLI scripts for terminal-driven flows.

---

**Oracle Feeds (Charli3 ODV / Preprod)**

| Pair | Policy ID |
|------|-----------|
| ADA-USD | `886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e` |
---

**Running It**

**Requirements:** Node 22+, npm, Docker.

```bash
npm install && npm run build:contract   # or: npm run bootstrap
```

Set root `.env` with: `BLOCKFROST_PROJECT_ID`, `WALLET_MNEMONIC`, `MIDNIGHT_BIP39_MNEMONIC`, `C3PERP_*` vars.

```bash
npm run proof-server   # terminal 1 — Midnight proof server on :6300
npm run perps:dev      # terminal 2 — frontend :5173, API :8791
```

Health check: `GET /api/health` · Oracle check: `GET /api/oracle?pair=ADA-USD`

Dry-run (no chain): `npx tsx scripts/trade-adausd-network.ts all --dry-run`

---

1. Clone repo, install Node 22+ + Docker
2. Add root `.env` (see `npm run bootstrap` for guidance)
3. Start proof server → `npm run perps:dev` → open Vite URL
4. Verify oracle endpoint; use `--dry-run` if on-chain keys aren't available