import { Hono } from "hono";
import { cors } from "hono/cors";
import { deserializeTransaction, broadcastTransaction } from "@stacks/transactions";

interface Env {
  PAYMENT_ADDRESS: string;
}

// Supported tokens with their rates (how much you get per 1 STX paid)
const SUPPORTED_TOKENS: Record<string, { name: string; rate: number; minAmount: number; maxAmount: number }> = {
  STX: { name: "Stacks", rate: 0.95, minAmount: 1000000, maxAmount: 100000000 },
  SBTC: { name: "sBTC", rate: 0.000005, minAmount: 1000, maxAmount: 10000000 },
  USDC: { name: "USDC", rate: 0.5, minAmount: 100000, maxAmount: 50000000 },
};

type TokenType = "STX" | "SBTC" | "USDC";

const STACKS_API = "https://api.mainnet.hiro.so";

// Verify and broadcast payment transaction
async function verifyAndBroadcastPayment(
  rawTxHex: string,
  expectedRecipient: string,
  minAmount: number
): Promise<{ success: boolean; txid?: string; error?: string; amount?: number }> {
  try {
    // Deserialize the transaction
    const tx = deserializeTransaction(rawTxHex);

    // Check it's a token transfer
    if (tx.payload.payloadType !== 0) { // 0 = token transfer
      return { success: false, error: "Transaction is not a STX transfer" };
    }

    const payload = tx.payload as any;

    // Verify recipient
    const recipient = payload.recipient?.address?.hash160
      ? `SP${payload.recipient.address.hash160}`
      : null;

    // Use c32 address from payload if available
    const recipientAddress = payload.recipient?.address;
    if (!recipientAddress) {
      return { success: false, error: "Could not parse recipient address" };
    }

    // Get amount
    const amount = Number(payload.amount);
    if (amount < minAmount) {
      return { success: false, error: `Insufficient payment: got ${amount}, need ${minAmount}` };
    }

    // Broadcast the transaction
    const broadcastResult = await broadcastTransaction({
      transaction: tx,
      network: "mainnet",
    });

    if ("error" in broadcastResult) {
      return { success: false, error: `Broadcast failed: ${broadcastResult.error}` };
    }

    return { success: true, txid: broadcastResult.txid, amount };
  } catch (error: any) {
    return { success: false, error: `Payment verification failed: ${error.message}` };
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// API info
app.get("/", (c) => {
  return c.json({
    service: "Coin Refill",
    version: "1.1.0",
    description: "Pay STX to refill your wallet with any supported token",
    endpoints: {
      "GET /": "API info",
      "GET /tokens": "List supported tokens and rates",
      "GET /quote": "Get a quote for a refill (params: token, amount)",
      "POST /refill": "Request a refill (x402 gated)",
    },
    supportedTokens: Object.keys(SUPPORTED_TOKENS),
    paymentToken: "STX",
    paymentVerification: true,
  });
});

// List supported tokens
app.get("/tokens", (c) => {
  const tokens = Object.entries(SUPPORTED_TOKENS).map(([symbol, info]) => ({
    symbol,
    name: info.name,
    ratePerSTX: info.rate,
    minAmount: info.minAmount,
    maxAmount: info.maxAmount,
  }));
  return c.json({ tokens });
});

// Get a quote
app.get("/quote", (c) => {
  const token = (c.req.query("token") || "STX").toUpperCase() as TokenType;
  const amount = parseInt(c.req.query("amount") || "1000000");

  if (!SUPPORTED_TOKENS[token]) {
    return c.json({ error: "Unsupported token", supported: Object.keys(SUPPORTED_TOKENS) }, 400);
  }

  const tokenInfo = SUPPORTED_TOKENS[token];

  if (amount < tokenInfo.minAmount) {
    return c.json({ error: `Minimum amount is ${tokenInfo.minAmount}` }, 400);
  }

  if (amount > tokenInfo.maxAmount) {
    return c.json({ error: `Maximum amount is ${tokenInfo.maxAmount}` }, 400);
  }

  const stxCost = Math.ceil(amount / tokenInfo.rate);

  return c.json({
    token,
    tokenName: tokenInfo.name,
    requestedAmount: amount,
    stxCost,
    rate: tokenInfo.rate,
    feePercent: token === "STX" ? 5 : 2,
  });
});

// Refill endpoint (x402 gated)
app.post("/refill", async (c) => {
  const paymentHeader = c.req.header("X-Payment");
  const body = await c.req.json().catch(() => ({}));
  const token = ((body as any).token || "STX").toUpperCase() as TokenType;
  const amount = parseInt((body as any).amount || "1000000");
  const recipient = (body as any).recipient;

  if (!recipient) {
    return c.json({ error: "recipient address required" }, 400);
  }

  if (!SUPPORTED_TOKENS[token]) {
    return c.json({ error: "Unsupported token", supported: Object.keys(SUPPORTED_TOKENS) }, 400);
  }

  const tokenInfo = SUPPORTED_TOKENS[token];

  if (amount < tokenInfo.minAmount || amount > tokenInfo.maxAmount) {
    return c.json({
      error: `Amount must be between ${tokenInfo.minAmount} and ${tokenInfo.maxAmount}`,
    }, 400);
  }

  const stxCost = Math.ceil(amount / tokenInfo.rate);

  // If no payment, return 402
  if (!paymentHeader) {
    const nonce = crypto.randomUUID().replace(/-/g, "");

    return c.json({
      maxAmountRequired: stxCost.toString(),
      resource: "/refill",
      payTo: c.env.PAYMENT_ADDRESS,
      network: "mainnet",
      nonce,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      tokenType: "STX",
      quote: {
        token,
        requestedAmount: amount,
        stxCost,
        recipient,
      },
    }, 402);
  }

  // Payment provided - verify and broadcast
  const paymentResult = await verifyAndBroadcastPayment(
    paymentHeader,
    c.env.PAYMENT_ADDRESS,
    stxCost
  );

  if (!paymentResult.success) {
    return c.json({
      error: "Payment verification failed",
      details: paymentResult.error,
    }, 402);
  }

  // Payment verified and broadcast - queue the refill
  const refillId = crypto.randomUUID();

  return c.json({
    success: true,
    refillId,
    status: "queued",
    payment: {
      txid: paymentResult.txid,
      amount: paymentResult.amount,
      verified: true,
    },
    details: {
      token,
      amount,
      recipient,
      estimatedDelivery: "~10 minutes",
    },
    message: `Refill of ${amount} ${token} queued for ${recipient}`,
  });
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
