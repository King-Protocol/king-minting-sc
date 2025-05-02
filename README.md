# King Retail Contract

## Installation

Prerequisites: install [Node.js](https://nodejs.org/en/download/package-manager) **20.11+** or **21.2+** and [Visual Studio Code](https://code.visualstudio.com/download).

Open **the root of the project** using Visual Studio Code and install all the extensions recommended by notifications of Visual Studio Code, then **restart** Visual Studio Code.

Open the terminal and run:

```bash
npm i
```

*(Optional) View all available npm scripts:*

```bash
npm run
```

---

## Deployment

Hardhat script **scripts/deployment/deploy/deploy_retailcore.ts** handles full deployment on a fork:

1. Prepare `.env` with the same fork variables you use for tests:

   ```env
   FORKING=true
   FORKING_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
   ```

2. Run the deploy script:

   ```bash
   npx hardhat run scripts/deployment/deploy_retailcore.ts
   ```

3. In `deploy_retailcore.ts`, tweak these constants at the top:

   ```ts
   const KING_ADDRESS    = "0x…";                // King vault on target net
   const DEPOSIT_FEE_BPS = 100;                  // 1% deposit fee
   const UNWRAP_FEE_BPS  = 100;                  // 1% unwrap fee
   const EPOCH_SECONDS   = 60;                   // epoch length (s)

   const LIMITS: Record<string, bigint> = { /* ... */ };
   ```

4. Verification doesn’t run when using a fork — comment out the verification step for mainnet deployments.
---

## Configuration

Project‑wide config lives in **`.env`** (copy `.env.example` and fill‑in your own values).

Key toggles you may need in day‑to‑day development:

| Variable        | Purpose                                     | Example                                  |
| --------------- | ------------------------------------------- | ---------------------------------------- |
| `FORKING`       | `true` to run Hardhat on a mainnet fork     | `true`                                   |
| `FORKING_URL`   | RPC endpoint that Hardhat will fork from    | `https://eth-mainxnet.g.alchemy.com/v2/…` |

---

## Testing

All tests are written with **Hardhat + Chai**.

```bash
npx hardhat test
```

> **Important!** The suite relies on a **mainnet fork** (for real token contracts & state). Before running, make sure `.env` contains:
>
> ```env
> FORKING=true
> FORKING_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
> ```

*Tips*

* If you want to run a single file: `npx hardhat test test/staking.test.ts`.

---

## Troubleshooting

Need a clean slate? Wipe artefacts & caches:

```bash
npm run clean
```

Then try again ✨






