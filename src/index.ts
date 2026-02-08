import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  deserializeTransaction,
  broadcastTransaction,
  makeSTXTokenTransfer,
  AnchorMode,
} from "@stacks/transactions";

interface Env {
  PAYMENT_ADDRESS: string;
  REFILL_PRIVATE_KEY: string; // Secret: private key for the refill wallet
}

// Supported tokens with their rates (how much you get per 1 STX paid)
const SUPPORTED_TOKENS: Record<string, { name: string; rate: number; minAmount: number; maxAmount: number }> = {
  STX: { name: "Stacks", rate: 0.95, minAmount: 1000, maxAmount: 100000000 }, // min 0.001 STX
};

type TokenType = "STX";
type PaymentTokenType = "STX" | "sBTC";

// sBTC contract for payment
const SBTC_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc";

// Payment rates: how much STX you get per payment token
const PAYMENT_RATES: Record<PaymentTokenType, number> = {
  STX: 1,      // 1 STX = 1 STX value
  sBTC: 50000, // 1 sat ≈ $0.001 ≈ 0.05 STX (rough equivalence)
};

// Verify and broadcast incoming payment
async function verifyAndBroadcastPayment(
  rawTxHex: string,
  minAmount: number
): Promise<{ success: boolean; txid?: string; error?: string; amount?: number }> {
  try {
    const tx = deserializeTransaction(rawTxHex);

    if (tx.payload.payloadType !== 0) {
      return { success: false, error: "Transaction is not a STX transfer" };
    }

    const payload = tx.payload as any;
    const amount = Number(payload.amount);

    if (amount < minAmount) {
      return { success: false, error: `Insufficient payment: got ${amount}, need ${minAmount}` };
    }

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

// Send the actual refill to recipient
async function sendRefill(
  privateKey: string,
  recipient: string,
  amount: number
): Promise<{ success: boolean; txid?: string; error?: string }> {
  try {
    const tx = await makeSTXTokenTransfer({
      recipient,
      amount: BigInt(amount),
      memo: "coin-refill",
      senderKey: privateKey,
      network: "mainnet",
      anchorMode: AnchorMode.Any,
    } as any);

    const broadcastResult = await broadcastTransaction({
      transaction: tx,
      network: "mainnet",
    });

    if ("error" in broadcastResult) {
      return { success: false, error: `Refill broadcast failed: ${broadcastResult.error}` };
    }

    return { success: true, txid: broadcastResult.txid };
  } catch (error: any) {
    return { success: false, error: `Refill failed: ${error.message}` };
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// API info
app.get("/", (c) => {
  return c.json({
    service: "Coin Refill",
    version: "2.0.0",
    description: "Pay STX or sBTC to refill any wallet with STX (5% fee)",
    endpoints: {
      "GET /": "API info",
      "GET /tokens": "List supported tokens and rates",
      "GET /quote": "Get a quote for a refill (params: token, amount, payWith)",
      "POST /refill": "Request a refill (x402 gated)",
    },
    supportedTokens: Object.keys(SUPPORTED_TOKENS),
    paymentTokens: ["STX", "sBTC"],
    paymentVerification: true,
    instantDelivery: true,
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
    feePercent: 5,
  });
});

// x402 discovery for /refill endpoint
app.get("/refill", (c) => {
  const tokenInfo = SUPPORTED_TOKENS.STX;
  // Default quote: 1 STX (1,000,000 microSTX)
  const defaultAmount = 1000000;
  const stxCost = Math.ceil(defaultAmount / tokenInfo.rate);

  return c.json({
    x402Version: 1,
    name: "Coin Refill",
    accepts: [
      {
        scheme: "exact",
        network: "stacks",
        maxAmountRequired: stxCost.toString(),
        resource: "/refill",
        description: "Refill wallets with STX (5% fee). Send POST with {token, amount, recipient}",
        mimeType: "application/json",
        payTo: c.env.PAYMENT_ADDRESS,
        maxTimeoutSeconds: 300,
        asset: "STX",
        outputSchema: {
          input: {
            type: "object",
            properties: {
              token: { type: "string", enum: ["STX"], description: "Token to receive" },
              amount: { type: "integer", description: "Amount in microSTX (min 1000, max 100000000)" },
              recipient: { type: "string", description: "Stacks address to receive refill" },
            },
            required: ["recipient"],
          },
          output: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              payment: {
                type: "object",
                properties: {
                  txid: { type: "string" },
                  amount: { type: "integer" },
                },
              },
              refill: {
                type: "object",
                properties: {
                  txid: { type: "string" },
                  token: { type: "string" },
                  amount: { type: "integer" },
                  recipient: { type: "string" },
                },
              },
              message: { type: "string" },
            },
          },
        },
      },
    ],
  });
});

// Helper to get payment token type from request
function getPaymentTokenType(c: any): PaymentTokenType {
  const queryToken = c.req.query("payWith");
  const headerToken = c.req.header("X-PAYMENT-TOKEN-TYPE");
  const tokenStr = (headerToken || queryToken || "STX").toUpperCase();
  return tokenStr === "SBTC" ? "sBTC" : "STX";
}

// Refill endpoint (x402 gated - accepts STX or sBTC)
app.post("/refill", async (c) => {
  const paymentHeader = c.req.header("X-Payment");
  const body = await c.req.json().catch(() => ({}));
  const token = ((body as any).token || "STX").toUpperCase() as TokenType;
  const amount = parseInt((body as any).amount || "1000000");
  const recipient = (body as any).recipient;
  const payWith = getPaymentTokenType(c);

  // Validate inputs
  if (!recipient) {
    return c.json({ error: "recipient address required" }, 400);
  }

  if (!recipient.startsWith("SP") && !recipient.startsWith("ST")) {
    return c.json({ error: "Invalid Stacks address" }, 400);
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

  // Calculate payment amount based on payment token
  let paymentAmount: number;
  if (payWith === "sBTC") {
    // Convert STX cost to sats (rough BTC equivalence)
    paymentAmount = Math.ceil(stxCost / PAYMENT_RATES.sBTC);
  } else {
    paymentAmount = stxCost;
  }

  // If no payment, return 402
  if (!paymentHeader) {
    const nonce = crypto.randomUUID().replace(/-/g, "");

    const paymentRequest: any = {
      maxAmountRequired: paymentAmount.toString(),
      resource: "/refill",
      payTo: c.env.PAYMENT_ADDRESS,
      network: "mainnet",
      nonce,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      tokenType: payWith,
      quote: {
        token,
        requestedAmount: amount,
        stxCost,
        recipient,
        payWith,
        paymentAmount,
      },
    };

    // Add token contract for sBTC
    if (payWith === "sBTC") {
      paymentRequest.tokenContract = {
        address: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
        name: "token-sbtc",
      };
    }

    return c.json(paymentRequest, 402);
  }

  // Check if refill wallet is configured
  if (!c.env.REFILL_PRIVATE_KEY) {
    return c.json({
      error: "Service not configured",
      details: "Refill wallet not set up",
    }, 503);
  }

  // Payment provided - verify and broadcast
  const paymentResult = await verifyAndBroadcastPayment(paymentHeader, stxCost);

  if (!paymentResult.success) {
    return c.json({
      error: "Payment verification failed",
      details: paymentResult.error,
    }, 402);
  }

  // Payment verified - now send the refill immediately
  const refillResult = await sendRefill(c.env.REFILL_PRIVATE_KEY, recipient, amount);

  if (!refillResult.success) {
    // Payment succeeded but refill failed - this is bad!
    // Log the payment txid so we can manually refund/retry
    console.error(`REFILL FAILED - Payment txid: ${paymentResult.txid}, recipient: ${recipient}, amount: ${amount}, error: ${refillResult.error}`);

    return c.json({
      error: "Refill failed after payment",
      details: refillResult.error,
      paymentTxid: paymentResult.txid,
      message: "Your payment was received. Please contact support with your payment txid for a refund.",
    }, 500);
  }

  // Success!
  return c.json({
    success: true,
    payment: {
      txid: paymentResult.txid,
      amount: paymentResult.amount,
    },
    refill: {
      txid: refillResult.txid,
      token,
      amount,
      recipient,
    },
    message: `Sent ${amount / 1000000} STX to ${recipient}`,
  });
});

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    refillWalletConfigured: !!c.env?.REFILL_PRIVATE_KEY,
  });
});

export default app;
