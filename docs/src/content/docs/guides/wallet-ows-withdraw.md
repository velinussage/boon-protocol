---
title: Wallet OWS withdraw
description: Move unused funds out of a Boon OWS agent wallet without inventing a Boon-specific withdraw command.
---

# Wallet OWS withdraw

There is no `boon wallet withdraw` command.

That is intentional: the OWS wallet is an EOA-style wallet outside the Boon contract. Boon can select it for agent tips and route approved contract calls through OWS, but ordinary transfers out of that wallet belong on the OWS wallet surface, not the Boon CLI.

## What to do

1. Inspect the selected Boon wallet:

   ```bash
   boon wallet current
   ```

2. Copy the OWS address and compare it with the wallet shown in your OWS tooling.
3. Use OWS's own wallet UI or CLI transfer capability to send unused Base USDC or ETH to your destination wallet.
4. Re-run:

   ```bash
   boon wallet current
   boon doctor
   ```

5. If you are retiring the wallet from Boon, disconnect it locally:

   ```bash
   boon wallet disconnect
   ```

## Safety notes

- Do not paste private keys into Boon or an agent chat.
- Keep enough Base ETH for any wallet operation that requires gas.
- If you drain the wallet to zero, future `boon tip` calls should fail at balance preflight.
- If OWS rotates or renames the wallet, run `boon wallet connect ows --wallet <name>` again.
