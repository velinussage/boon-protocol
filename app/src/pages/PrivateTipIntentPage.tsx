import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { estimateGas, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { base } from "wagmi/chains";
import { useAccount, useConnect, useSwitchChain, useWriteContract } from "wagmi";
import { encodeFunctionData, getAddress, isAddress, type Hex } from "viem";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import { boonV3Abi, emptyPermit } from "../lib/boonAbi";
import { fetchPrivateTipIntentExecution, formatUsdc, type PrivateTipIntentExecutionResponse } from "../lib/api";
import { config } from "../lib/wagmi";
import { readableWalletError, type UiError } from "../lib/errors";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const PRIVATE_TIP_BURN_WEI = 500_000n * 10n ** 18n;
const ATTESTATION_BURN_WEI = 3_000_000n * 10n ** 18n;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type PageStatus = "loading" | "ready" | "executing" | "success" | "error";

function gasWithSafetyBuffer(estimate: bigint): bigint {
  return (estimate * 130n) / 100n + 10_000n;
}

export function PrivateTipIntentPage() {
  const { intentId = "" } = useParams();
  const [detail, setDetail] = useState<PrivateTipIntentExecutionResponse | null>(null);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [error, setError] = useState<UiError | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [approvalLabel, setApprovalLabel] = useState<string | null>(null);

  const { address, chainId, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const existingWalletConnector = useMemo(
    () =>
      connectors.find((c) => /metamask/i.test(c.name) || c.id === "metaMask" || c.type === "metaMask") ??
      connectors.find((c) => c.type === "injected") ??
      connectors.find((c) => c.id === "injected") ??
      connectors.find((c) => /metamask|rabby|rainbow|brave|frame/i.test(c.name)) ??
      connectors[0],
    [connectors],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!intentId) {
        setStatus("error");
        setError({ summary: "Missing private tip intent id." });
        return;
      }
      setStatus("loading");
      setError(null);
      try {
        const next = await fetchPrivateTipIntentExecution(intentId);
        if (cancelled) return;
        setDetail(next);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(readableWalletError(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [intentId]);

  const requiredBoonBurn = detail
    ? PRIVATE_TIP_BURN_WEI + (detail.mintAttestation ? ATTESTATION_BURN_WEI : 0n)
    : 0n;
  const connectedIsTipper = Boolean(
    address && detail?.tipper && address.toLowerCase() === detail.tipper.toLowerCase(),
  );
  const canExecute = Boolean(
    detail?.status === "ready" &&
      detail.expectedWallet &&
      detail.privateCommitment &&
      connectedIsTipper &&
      status !== "executing" &&
      status !== "success",
  );
  const recipientClaimHref = useMemo(() => {
    if (!detail) return "/claim";
    return `/claim?handle=${encodeURIComponent(detail.displayHandle)}`;
  }, [detail]);

  async function ensureWallet(): Promise<`0x${string}`> {
    if (isConnected && address) return address;
    if (!existingWalletConnector) throw new Error("No browser wallet connector was found.");
    const res = await connectAsync({ connector: existingWalletConnector, chainId: base.id });
    const account = res.accounts[0];
    if (!account) throw new Error("wallet did not return an account");
    return account;
  }

  async function ensureBaseChain() {
    if (!chainId || chainId === base.id) return;
    if (!switchChainAsync) throw new Error("Switch your wallet to Base, then try again.");
    await switchChainAsync({ chainId: base.id });
  }

  function readConfiguredAddress(name: "VITE_BOON_V3_CONTRACT" | "VITE_BOON_TOKEN_ADDRESS"): `0x${string}` {
    const value = import.meta.env[name] as string | undefined;
    if (!value || value === ZERO_ADDRESS || !isAddress(value)) {
      throw new Error(`${name} is not configured yet.`);
    }
    return getAddress(value) as `0x${string}`;
  }

  async function readAllowance(owner: `0x${string}`, spender: `0x${string}`, token: `0x${string}`): Promise<bigint> {
    return await readContract(config, {
      address: token,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [owner, spender],
      chainId: base.id,
    });
  }

  async function approveIfNeeded({
    token,
    spender,
    owner,
    amount,
    label,
  }: {
    token: `0x${string}`;
    spender: `0x${string}`;
    owner: `0x${string}`;
    amount: bigint;
    label: "USDC" | "$BOON";
  }) {
    const current = await readAllowance(owner, spender, token);
    if (current >= amount) return;
    setApprovalLabel(`Approving ${label}…`);
    const approveData = encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [spender, amount],
    });
    const gas = gasWithSafetyBuffer(
      await estimateGas(config, {
        account: owner,
        chainId: base.id,
        data: approveData,
        to: token,
      }),
    );
    const hash = await writeContractAsync({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "approve",
      chainId: base.id,
      args: [spender, amount],
      gas,
    });
    await waitForTransactionReceipt(config, { hash });
  }

  function executeIntent() {
    setError(null);
    void (async () => {
      try {
        if (!detail) throw new Error("Private tip intent has not loaded yet.");
        if (detail.status !== "ready" || !detail.expectedWallet || !detail.privateCommitment) {
          throw new Error(detail.message ?? "Recipient is not linked on Boon yet.");
        }
        const account = await ensureWallet();
        await ensureBaseChain();
        if (account.toLowerCase() !== detail.tipper.toLowerCase()) {
          throw new Error(`Connect the original tipper wallet ${shortAddr(detail.tipper)} to execute this private tip.`);
        }

        const v3Contract = readConfiguredAddress("VITE_BOON_V3_CONTRACT");
        const boonToken = readConfiguredAddress("VITE_BOON_TOKEN_ADDRESS");
        const amount = BigInt(detail.amount);
        setStatus("executing");
        await approveIfNeeded({ token: USDC_BASE, spender: v3Contract, owner: account, amount, label: "USDC" });
        await approveIfNeeded({ token: boonToken, spender: v3Contract, owner: account, amount: requiredBoonBurn, label: "$BOON" });

        setApprovalLabel("Sending private tip…");
        const tipArgs = [
          detail.handleHash as Hex,
          detail.displayHandle,
          detail.expectedWallet as `0x${string}`,
          amount,
          detail.privateCommitment as Hex,
          detail.mintAttestation,
          emptyPermit,
        ] as const;
        const tipData = encodeFunctionData({
          abi: boonV3Abi,
          functionName: "tipPrivate",
          args: tipArgs,
        });
        const tipGas = gasWithSafetyBuffer(
          await estimateGas(config, {
            account,
            chainId: base.id,
            data: tipData,
            to: v3Contract,
          }),
        );
        const hash = await writeContractAsync({
          address: v3Contract,
          abi: boonV3Abi,
          functionName: "tipPrivate",
          chainId: base.id,
          args: tipArgs,
          gas: tipGas,
        });
        await waitForTransactionReceipt(config, { hash });
        setTxHash(hash);
        setApprovalLabel(null);
        setStatus("success");
      } catch (err) {
        setApprovalLabel(null);
        setStatus("error");
        setError(readableWalletError(err));
      }
    })();
  }

  return (
    <>
      <Nav current="send" />
      <main className="overflow-x-clip">
        <section className="px-6 md:px-10 pt-12 md:pt-24 max-w-2xl mx-auto">
          <header className="animate-fade-up">
            <p className="btn-mono text-muted">private intent</p>
            <h1 className="mt-3 text-4xl md:text-5xl font-display tracking-tight leading-[0.98]">
              {detail?.status === "waiting"
                ? "A private thank-you is waiting."
                : "Execute a prepared private thank-you."}
            </h1>
            <p className="mt-4 text-sm text-muted leading-relaxed">
              {detail?.status === "waiting"
                ? "This link is useful to both people: the recipient can claim/link the handle, and the sender can return here later to finish the private tip."
                : (
                  <>
                    This page is for the original sender. It turns a queued private intent into the final onchain <span className="btn-mono">tipPrivate</span> transaction after the recipient has linked on Boon.
                  </>
                )}
            </p>
          </header>

          <div className="mt-10 md:mt-12 card p-6 md:p-8 animate-fade-up" style={{ animationDelay: "120ms" }}>
            {status === "loading" && <p className="text-sm text-muted">Loading private tip intent…</p>}

            {detail && (
              <div className="space-y-5">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Info label="Status" value={detail.status === "waiting" ? "needs recipient link" : "ready for sender"} />
                  <Info label="Recipient" value={detail.displayHandle} />
                  <Info label="Prepared amount" value={formatUsdc(detail.amount).replace("$", "") + " USDC"} />
                  <Info label="Tipper wallet" value={shortAddr(detail.tipper)} mono />
                  <Info label="Recipient wallet" value={detail.expectedWallet ? shortAddr(detail.expectedWallet) : "not linked yet"} mono={Boolean(detail.expectedWallet)} />
                  <Info label="$BOON burn" value={formatBoon(requiredBoonBurn)} />
                  <Info label="Recipient proof" value={detail.mintAttestation ? "yes" : "no"} />
                </div>

                {detail.status === "waiting" && (
                  <div className="rounded-md border border-amber-300/50 bg-amber-100/30 p-4 text-sm text-amber-900 leading-relaxed space-y-3">
                    <div>
                      <p className="font-medium text-amber-950">Recipient action needed</p>
                      <p className="mt-1">
                        <span className="chip">{detail.displayHandle}</span> is not linked on Boon for this intent yet. If this is your handle, claim/link it first.
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-amber-950">Sender action later</p>
                      <p className="mt-1">
                        No funds have moved. After the recipient links, the original sender wallet <span className="chip">{shortAddr(detail.tipper)}</span> comes back to this same page to sign the final private tip.
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      <Link
                        to={recipientClaimHref}
                        className="btn btn-primary justify-center text-center"
                      >
                        Claim / link recipient handle
                      </Link>
                      <button
                        type="button"
                        onClick={() => void copyToClipboard(window.location.href)}
                        className="btn btn-ghost justify-center text-center"
                      >
                        Copy sender return link
                      </button>
                    </div>
                  </div>
                )}

                {detail.status === "ready" && !connectedIsTipper && (
                  <div className="rounded-md border border-faint bg-paper-deep/60 p-4 text-sm text-muted leading-relaxed">
                    Connect the original tipper wallet <span className="chip">{shortAddr(detail.tipper)}</span> to execute. Other wallets can view this page but cannot complete the send.
                  </div>
                )}

                {txHash && (
                  <a
                    href={`https://basescan.org/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost w-full justify-center"
                  >
                    View transaction on BaseScan ↗
                  </a>
                )}

                <button
                  type="button"
                  onClick={executeIntent}
                  disabled={status === "executing" || status === "success" || detail.status !== "ready"}
                  className="btn btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {status === "executing"
                    ? approvalLabel ?? "Executing…"
                    : status === "success"
                      ? "Private tip sent ✓"
                      : detail.status !== "ready"
                        ? "Waiting for recipient to claim/link"
                      : !address
                        ? "Connect tipper wallet"
                      : !connectedIsTipper
                        ? "Wrong wallet connected"
                        : `Execute ${formatUsdc(detail.amount).replace("$", "")} private tip`}
                </button>
              </div>
            )}

            {error && (
              <div className="mt-5 rounded-md border border-danger/30 bg-paper-deep/60 p-4 text-sm text-danger leading-relaxed">
                {error.summary}
                {error.detail && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted">{error.detail}</pre>}
              </div>
            )}
          </div>

          <p className="mt-8 text-sm text-muted leading-relaxed">
            Recipient? Claim/link the handle first. Sender? Save this page and return after the recipient links. The private tip is not funded until the sender signs the final transaction.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-faint bg-paper-deep/60 p-3">
      <p className="btn-mono text-[0.65rem] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-ink ${mono ? "btn-mono text-sm break-all" : "num text-lg"}`}>{value}</p>
    </div>
  );
}

function formatBoon(value: bigint): string {
  const whole = value / 10n ** 18n;
  return `${whole.toLocaleString()} $BOON`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Copy is a convenience for the sender return link; ignore browser
    // clipboard restrictions instead of interrupting the recipient flow.
  }
}
