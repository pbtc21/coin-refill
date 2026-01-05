import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
  PAYMENT_ADDRESS: string;
}

// Supported tokens with their rates (how much you get per 1 STX paid)
const SUPPORTED_TOKENS: Record<string, { name: string; rate: number; minAmount: number; maxAmount: number }> = {
  STX: { name: "Stacks", rate: 0.95, minAmount: 1000000, maxAmount: 100000000 }, // 1 STX = 0.95 STX (5% fee)
  SBTC: { name: "sBTC", rate: 0.000005, minAmount: 1000, maxAmount: 10000000 }, // ~$50k STX per BTC
  USDC: { name: "USDC", rate: 0.5, minAmount: 100000, maxAmount: 50000000 }, // ~$0.50 per STX
};

type TokenType = "STX" | "SBTC" | "USDC";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// API info
app.get("/", (c) => {
  return c.json({
    service: "Coin Refill",
    version: "1.0.0",
    description: "Pay STX to refill your wallet with any supported token",
    endpoints: {
      "GET /": "API info",
      "GET /tokens": "List supported tokens and rates",
      "GET /quote": "Get a quote for a refill (params: token, amount)",
      "POST /refill": "Request a refill (x402 gated)",
    },
    supportedTokens: Object.keys(SUPPORTED_TOKENS),
    paymentToken: "STX",
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

  // Calculate STX cost (amount / rate)
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

  // If no payment, return 402
  if (!paymentHeader) {
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

  // Payment provided - process the refill
  const body = await c.req.json().catch(() => ({}));
  const token = ((body as any).token || "STX").toUpperCase() as TokenType;
  const amount = parseInt((body as any).amount || "1000000");
  const recipient = (body as any).recipient;

  if (!recipient) {
    return c.json({ error: "recipient address required" }, 400);
  }

  // In production: verify payment, then execute the token transfer
  // For now, simulate success and return refill details

  const refillId = crypto.randomUUID();
  const tokenInfo = SUPPORTED_TOKENS[token as TokenType];

  return c.json({
    success: true,
    refillId,
    status: "queued",
    details: {
      token,
      amount,
      recipient,
      estimatedDelivery: "~10 minutes",
    },
    message: `Refill of ${amount} ${token} queued for ${recipient}`,
    // In production, this would be the actual transfer txid
    transferTxId: null,
  });
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
