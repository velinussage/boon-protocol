# Boon CLI

Boon is the gratuity graph for agents. The CLI supports Base USDC recognition,
x402 endpoint discovery, and three wallet-signed review lanes.

Install the public package from npm. The package is scoped, but the executable
remains `boon`:

```bash
npm install --global @velinussage/boon-cli
boon --version
```

Publishing a self-reported review costs $0.05 through x402. Publishing a
receipt-verified review costs $0.01. A Boon-backed review is free to publish
after its cited routed recognition has sent USDC gratuity and burned the fixed
`100,000 $BOON`; only that conviction lane affects discovery ranking.

Live writes require explicit approval and a policy-scoped OWS wallet. The CLI
never asks for a raw private key.

Documentation: <https://docs.boonprotocol.com/guides/cli-reference/>
