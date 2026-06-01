/**
 * CareGuard Agent Tools — Real payment integrations on Stellar testnet
 *
 * x402 client: Signs Soroban auth entries, pays USDC per API query via OZ facilitator
 * MPP client: Signs Soroban transfers, pays pharmacies via MPP charge mode
 * Stellar USDC: Direct USDC transfers for bill payments via Horizon
 * Spending policy: Persisted to file, enforced before every payment.
 *   ⚠️  DO NOT COMMIT data/spending.json or data/orders.json — they contain
 *   live balances and transaction history. Add them to .gitignore and never
 *   include them in a PR. See data/README.md for details.
 *
 * Multi-recipient: Every tool accepts recipientId; data is stored per-recipient.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { logger } from "../shared/logger.ts";
import { Keypair, Networks, TransactionBuilder, Operation, Asset, Horizon } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer, ExactStellarScheme } from "@x402/stellar";
import { Mppx } from "mppx/client";
import { stellar as stellarCharge } from "@stellar/mpp/charge/client";
import type { SpendingPolicy, Transaction } from "../shared/types.ts";
import { SPENDING_TIMEZONE, getLocalDateStr } from "./tz.ts";
export { SPENDING_TIMEZONE, getLocalDateStr };
import { appendAuditEntry } from "../shared/audit-log.ts";
import { notify } from "../shared/notifications.ts";
import { appendAdherenceRecord, getAdherenceSummary, getPendingAdherences, confirmAdherence, getFlaggedAdherences } from "../shared/adherence.ts";
import {
  x402SettlementsTotal,
  paymentsUsdcTotal,
  stellarTxSubmittedTotal,
  policyBlocksTotal,
  agentSpendingUsd,
  agentTransactionsTotal,
} from "../shared/metrics.ts";

// Environment
const AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY;
const PHARMACY_API = process.env.PHARMACY_API_URL || "http://localhost:3001";
const BILL_AUDIT_API = process.env.BILL_AUDIT_API_URL || "http://localhost:3002";
const DRUG_INTERACTION_API = process.env.DRUG_INTERACTION_API_URL || "http://localhost:3003";
const PHARMACY_PAYMENT_API = process.env.PHARMACY_PAYMENT_API_URL || "http://localhost:3005";
const USDC_ISSUER = process.env.USDC_ISSUER || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

if (!AGENT_SECRET_KEY) throw new Error("AGENT_SECRET_KEY required in .env");

const agentKeypair = Keypair.fromSecret(AGENT_SECRET_KEY);
const horizonServer = new Horizon.Server(HORIZON_URL);

const BASE_DATA_DIR = new URL("../data", import.meta.url).pathname;
if (!existsSync(BASE_DATA_DIR)) mkdirSync(BASE_DATA_DIR, { recursive: true });

const RECIPIENTS_DIR = `${BASE_DATA_DIR}/recipients`;
if (!existsSync(RECIPIENTS_DIR)) mkdirSync(RECIPIENTS_DIR, { recursive: true });

// Migration: move existing flat data/ files into recipients/rosa/
function migrateLegacyData() {
  const legacyFiles = [
    { src: `${BASE_DATA_DIR}/spending.json`, dst: `${BASE_DATA_DIR}/recipients/rosa/spending.json` },
    { src: `${BASE_DATA_DIR}/orders.json`, dst: `${BASE_DATA_DIR}/recipients/rosa/orders.json` },
    { src: `${BASE_DATA_DIR}/policy.json`, dst: `${BASE_DATA_DIR}/recipients/rosa/policy.json` },
  ];
  if (!existsSync(`${BASE_DATA_DIR}/recipients/rosa`)) mkdirSync(`${BASE_DATA_DIR}/recipients/rosa`, { recursive: true });
  for (const { src, dst } of legacyFiles) {
    if (existsSync(src) && !existsSync(dst)) {
      try {
        renameSync(src, dst);
        logger.info({ src, dst }, "migrated legacy data file");
      } catch (err: any) {
        logger.warn({ err: err.message, src }, "could not migrate legacy file");
      }
    }
  }
}
migrateLegacyData();

function recipientDir(recipientId: string): string {
  const dir = `${RECIPIENTS_DIR}/${recipientId}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper: extract real Stellar tx hash from x402 PAYMENT-RESPONSE header
function extractX402TxHash(response: Response): string | undefined {
  const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("payment-response") || response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    const decoded = decodePaymentResponseHeader(header);
    return decoded.transaction || undefined;
  } catch {
    return header.length === 64 ? header : undefined;
  }
}

// Helper: submitTransaction with timeout and retry
async function submitTransactionWithRetry(
  server: Horizon.Server,
  tx: any,
  maxRetries = 2,
  timeoutMs = 35000
): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await server.submitTransaction(tx, { timeout: timeoutMs });
      return result;
    } catch (err: any) {
      lastError = err;
      if (err?.response?.status) throw err;
      const msg = err?.message ?? "";
      if (msg.includes("tx_bad_seq") || msg.includes("tx_too_early") || msg.includes("tx_too_late")) throw err;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500;
        logger.warn({ attempt: attempt + 1, maxRetries, delay }, "[Stellar] submitTransaction timeout, retrying");
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// Helper: wait for a Stellar transaction to be confirmed on-chain
async function waitForStellarSettlement(txHash: string, maxRetries = 5, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await horizonServer.transactions().transaction(txHash).call();
      return true;
    } catch {
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return false;
}

// --- x402 Client ---
const signer = createEd25519Signer(AGENT_SECRET_KEY, "stellar:testnet");
const x402ClientInstance = new x402Client().register("stellar:testnet", new ExactStellarScheme(signer));
const x402Fetch = wrapFetchWithPayment(fetch, x402ClientInstance);

// --- MPP Client ---
let lastMppTxHash: string | undefined;

const mppClient = Mppx.create({
  methods: [
    stellarCharge({
      keypair: agentKeypair,
      mode: "pull",
      onProgress: (event) => {
        logger.info({ type: event.type, hash: "hash" in event ? (event as any).hash : undefined }, "[MPP] progress");
        if (event.type === "paid" && "hash" in event) {
          lastMppTxHash = (event as any).hash;
        }
      },
    }),
  ],
  polyfill: false,
});

// In-memory caches so writes are immediately visible (required for tests)
const policyCache = new Map<string, SpendingPolicy>();
const spendingCache = new Map<string, SpendingTracker>();

// --- Per-recipient persistent state ---
interface SpendingTracker {
  medications: number;
  bills: number;
  serviceFees: number;
  transactions: Transaction[];
}

function loadSpending(recipientId: string): SpendingTracker {
  const cached = spendingCache.get(recipientId);
  if (cached) return cached;
  const file = `${recipientDir(recipientId)}/spending.json`;
  if (!existsSync(file)) return { medications: 0, bills: 0, serviceFees: 0, transactions: [] };
  const data: SpendingTracker = JSON.parse(readFileSync(file, "utf-8"));
  spendingCache.set(recipientId, data);
  return data;
}

export function saveSpending(recipientId: string, data: SpendingTracker) {
  spendingCache.set(recipientId, data);
  writeFileSync(`${recipientDir(recipientId)}/spending.json`, JSON.stringify(data, null, 2));
}

function loadPolicyFor(recipientId: string): SpendingPolicy {
  const cached = policyCache.get(recipientId);
  if (cached) return cached;
  const file = `${recipientDir(recipientId)}/policy.json`;
  if (!existsSync(file)) {
    const dflt = { ...DEFAULT_POLICY };
    policyCache.set(recipientId, dflt as SpendingPolicy);
    return dflt as SpendingPolicy;
  }
  try {
    const data: SpendingPolicy = JSON.parse(readFileSync(file, "utf-8"));
    policyCache.set(recipientId, data);
    return data;
  } catch {
    const dflt = { ...DEFAULT_POLICY };
    policyCache.set(recipientId, dflt as SpendingPolicy);
    return dflt as SpendingPolicy;
  }
}

function savePolicyFor(recipientId: string, policy: SpendingPolicy) {
  policyCache.set(recipientId, policy);
  writeFileSync(`${recipientDir(recipientId)}/policy.json`, JSON.stringify(policy, null, 2));
}

const MAX_PAYMENT = 1000;
const MAX_ERROR_LENGTH = 500;

function truncateError(message: string): string {
  return message.replace(/<[^>]*>/g, "").slice(0, MAX_ERROR_LENGTH);
}

const DEFAULT_POLICY: SpendingPolicy & { notificationOptIn?: { email: boolean; sms: boolean; slack: boolean } } = {
  dailyLimit: 100,
  monthlyLimit: 500,
  medicationMonthlyBudget: 300,
  billMonthlyBudget: 500,
  approvalThreshold: 75,
  notificationOptIn: { email: true, sms: false, slack: true },
};

const NOTIFICATION_THRESHOLD = 50; // notify on payments above this amount

// No global state — everything is per-recipient

export function setSpendingPolicy(recipientId: string, policy: SpendingPolicy) {
  const previous = loadPolicyFor(recipientId);
  savePolicyFor(recipientId, policy);
  appendAuditEntry({
    event: "policy.updated",
    actor: "caregiver",
    details: { recipientId, previous: { ...previous }, current: { ...policy } },
  });
  notify({
    level: "info",
    title: "Spending Policy Updated",
    description: `Caregiver updated spending policy for ${recipientId}.`,
    context: { previous, current: policy },
  });
}

export function getSpendingTracker(recipientId: string = "rosa") {
  const spending = loadSpending(recipientId);
  const policy = loadPolicyFor(recipientId);
  return { ...spending, policy };
}

export function resetSpendingTracker(recipientId: string = "rosa") {
  const spending = loadSpending(recipientId);
  const previousTotal = spending.medications + spending.bills + spending.serviceFees;
  const empty = { medications: 0, bills: 0, serviceFees: 0, transactions: [] };
  spendingCache.set(recipientId, empty);
  saveSpending(recipientId, empty);
  appendAuditEntry({
    event: "spending.reset",
    actor: "caregiver",
    details: { recipientId, previousTotal: +previousTotal.toFixed(2) },
  });
}

// --- Tool: Compare pharmacy prices (pays via x402) ---
export async function comparePharmacyPrices(drugName: string, zipCode: string = "90210") {
  const url = `${PHARMACY_API}/pharmacy/compare?drug=${encodeURIComponent(drugName)}&zip=${encodeURIComponent(zipCode)}`;
  logger.info({ drug: drugName }, "[x402] paying for pharmacy price query");

  const response = await x402Fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Pharmacy API error (${response.status}): ${truncateError(error)}`);
  }

  const data = await response.json();

  const txHash = extractX402TxHash(response);

  if (txHash) {
    const settled = await waitForStellarSettlement(txHash);
    if (!settled) {
      throw new Error(`x402 settlement not confirmed on-chain for tx ${txHash}`);
    }
  }

  x402SettlementsTotal.inc();
  // Fee is not tied to a specific recipient — tracked globally
  return data;
}

// --- Tool: Fetch hospital bill (free endpoint) ---
export async function fetchRosaBill() {
  logger.info("[fetch] getting Rosa's hospital bill");

  const response = await fetch(`${BILL_AUDIT_API}/bill/sample`);

  if (!response.ok) {
    throw new Error(`Failed to fetch bill (${response.status}): service may be starting up. Try again in a moment.`);
  }

  return await response.json();
}

// --- Tool: Fetch bill AND audit it (pays via x402) ---
export async function fetchAndAuditBill(recipientId: string = "rosa") {
  logger.info("[fetch+audit] getting Rosa's bill and auditing it");

  const billResponse = await fetch(`${BILL_AUDIT_API}/bill/sample`);
  if (!billResponse.ok) {
    throw new Error(`Failed to fetch bill (${billResponse.status}): service may be starting up.`);
  }
  const bill = await billResponse.json();

  return await auditBill(bill.lineItems, recipientId);
}

// --- Tool: Audit a medical bill (pays via x402) ---
export async function auditBill(
  lineItems: Array<{ description: string; cptCode: string; quantity: number; chargedAmount: number }>,
  recipientId: string = "rosa"
) {
  logger.info({ lineItemCount: lineItems.length }, "[x402] paying for bill audit");

  let response: Response;
  try {
    response = await x402Fetch(`${BILL_AUDIT_API}/bill/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineItems }),
    });
  } catch (err: any) {
    const baseUrl = BILL_AUDIT_API;
    const docsHint = "See docs/setup/services.md for local service setup.";
    const message = typeof err?.message === "string" ? err.message : "Unknown network error";
    const code = err?.cause?.code || err?.code;

    if (code === "ECONNREFUSED") {
      throw new Error(
        `Bill Audit API connection refused (ECONNREFUSED). This is usually a config or startup issue. ` +
        `Ensure BILL_AUDIT_API_URL points to a running service (currently ${baseUrl}). ${docsHint}`
      );
    }

    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_SOCKET") {
      throw new Error(
        `Bill Audit API request timed out. This is often transient (network hiccup or cold start). ` +
        `Try again; if it persists, verify the service at ${baseUrl} is reachable. ${docsHint}`
      );
    }

    if (code === "ENOTFOUND") {
      throw new Error(
        `Bill Audit API hostname not found (ENOTFOUND). Check BILL_AUDIT_API_URL (currently ${baseUrl}). ${docsHint}`
      );
    }

    throw new Error(
      `Bill Audit API unreachable. ${message}. Verify the service is reachable at ${baseUrl}. ${docsHint}`
    );
  }

  if (!response.ok) {
    const error = await response.text();
    const bodyPreview = truncateError(error);

    if (response.status >= 500) {
      throw new Error(
        `Bill Audit API is up but failing (${response.status}). This indicates a downstream/service bug or outage. ` +
        `Try again later or check the Bill Audit service logs. Details: ${bodyPreview}`
      );
    }

    if (response.status >= 400 && response.status < 500) {
      throw new Error(
        `Bill Audit API rejected the request (${response.status}). This is likely a caller/input issue. ` +
        `Verify the payload schema and required env vars. Details: ${bodyPreview}`
      );
    }

    throw new Error(`Bill Audit API error (${response.status}): ${bodyPreview}`);
  }

  const data = await response.json();

  const txHash = extractX402TxHash(response);

  if (txHash) {
    const settled = await waitForStellarSettlement(txHash);
    if (!settled) {
      throw new Error(`x402 settlement not confirmed on-chain for tx ${txHash}`);
    }
  }

  const spending = loadSpending(recipientId);
  x402SettlementsTotal.inc();
  spending.serviceFees += 0.01;
  spending.transactions.push({
    id: `tx-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "service_fee",
    description: "x402 query: medical bill audit",
    amount: 0.01,
    recipient: data.protocol?.payTo || "bill-audit-api",
    stellarTxHash: txHash,
    status: "completed",
    category: "service_fees",
  });
  agentTransactionsTotal.inc({ status: "completed" });
  agentSpendingUsd.set({ category: "service_fees" }, spending.serviceFees);
  saveSpending(recipientId, spending);

  // Notify if errors found (#265)
  if (data.errorCount > 0) {
    notify({
      level: "warning",
      title: "Bill Audit Found Errors",
      description: `${data.errorCount} errors found in bill for ${recipientId}. Overcharges: $${data.totalOvercharge}.`,
      context: { recipientId, errorCount: data.errorCount, totalOvercharge: data.totalOvercharge },
    });
  }

  return data;
}

// --- Tool: Check drug interactions (pays via x402) ---
export async function checkDrugInteractions(medications: string[]) {
  const medsParam = medications.join(",");
  logger.info({ medicationCount: medications.length }, "[x402] paying for drug interaction check");

  const response = await x402Fetch(`${DRUG_INTERACTION_API}/drug/interactions?meds=${encodeURIComponent(medsParam)}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drug Interaction API error (${response.status}): ${truncateError(error)}`);
  }

  const data = await response.json();

  const txHash = extractX402TxHash(response);

  if (txHash) {
    const settled = await waitForStellarSettlement(txHash);
    if (!settled) {
      throw new Error(`x402 settlement not confirmed on-chain for tx ${txHash}`);
    }
  }

  x402SettlementsTotal.inc();
  return data;
}

// --- Tool: Check spending policy ---
export function checkSpendingPolicy(amount: number, category: "medications" | "bills", recipientId: string = "rosa") {
  const policy = loadPolicyFor(recipientId);
  const spending = loadSpending(recipientId);
  const budget = category === "medications" ? policy.medicationMonthlyBudget : policy.billMonthlyBudget;
  const currentSpending = category === "medications" ? spending.medications : spending.bills;
  const remaining = budget - currentSpending;

  if (amount > remaining) {
    return {
      allowed: false,
      reason: `Payment of $${amount.toFixed(2)} exceeds ${category} monthly budget. Budget: $${budget}, spent: $${currentSpending.toFixed(2)}, remaining: $${remaining.toFixed(2)}`,
      requiresApproval: false, currentSpending, budgetRemaining: remaining,
    };
  }

  const today = getLocalDateStr(SPENDING_TIMEZONE);
  const totalToday = spending.transactions
    .filter(t => getLocalDateStr(SPENDING_TIMEZONE, new Date(t.timestamp)) === today && t.category === category)
    .reduce((sum, t) => sum + t.amount, 0);

  if (totalToday + amount > policy.dailyLimit) {
    return {
      allowed: false,
      reason: `Payment of $${amount.toFixed(2)} would exceed daily limit of $${policy.dailyLimit}. Already spent today: $${totalToday.toFixed(2)}`,
      requiresApproval: false, currentSpending, budgetRemaining: remaining,
    };
  }

  return { allowed: true, requiresApproval: amount > policy.approvalThreshold, currentSpending, budgetRemaining: remaining - amount };
}

// --- Tool: Pay for medication via MPP Charge ---
export async function payForMedication(
  pharmacyId: string, pharmacyName: string, drugName: string, amount: number,
  skipApproval: boolean = false, recipientId: string = "rosa"
) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PAYMENT) {
    return { success: false, error: `Invalid payment amount: $${amount}. Amount must be a positive finite number <= $${MAX_PAYMENT}.` };
  }
  const policy = loadPolicyFor(recipientId);
    const policyCheck = checkSpendingPolicy(amount, "medications", recipientId);
  if (!policyCheck.allowed) {
    const reason = (policyCheck.reason || "").includes("daily") ? "daily_limit" : "budget";
    policyBlocksTotal.inc({ reason });
    return { success: false, error: `BLOCKED BY SPENDING POLICY: ${policyCheck.reason}` };
  }
  if (policyCheck.requiresApproval && !skipApproval) {
    policyBlocksTotal.inc({ reason: "approval_required" });
    const spending = loadSpending(recipientId);
    const tx: Transaction = {
      id: `tx-${Date.now()}`, timestamp: new Date().toISOString(), type: "medication",
      description: `${drugName} from ${pharmacyName}`, amount, recipient: pharmacyId,
      status: "pending", category: "medications",
    };
    spending.transactions.push(tx);
    agentTransactionsTotal.inc({ status: "pending" });
    saveSpending(recipientId, spending);
    return { success: false, error: `REQUIRES CAREGIVER APPROVAL: $${amount.toFixed(2)} exceeds the $${policy.approvalThreshold} approval threshold.`, transaction: tx };
  }

  logger.info({ pharmacy: pharmacyName, amount }, "[MPP] paying for medication");

  let stellarTxHash: string | undefined;
  let mppOrderId: string | undefined;
  lastMppTxHash = undefined;

  try {
    const response = await mppClient.fetch(`${PHARMACY_PAYMENT_API}/pharmacy/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drug: drugName, pharmacy: pharmacyName, amount }),
    });

    const data = await response.json();
    if (data.success) {
      stellarTxHash = lastMppTxHash;
      if (!stellarTxHash) {
        const receiptHeader = response.headers.get("Payment-Receipt") || response.headers.get("payment-receipt");
        if (receiptHeader) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString());
            stellarTxHash = receipt.reference || receipt.hash || receipt.transaction;
          } catch {
            stellarTxHash = receiptHeader;
          }
        }
      }
      mppOrderId = data.order?.id;
    } else {
      throw new Error(data.error || "MPP payment failed");
    }
  } catch (err: any) {
    stellarTxSubmittedTotal.inc({ result: "error" });
    return { success: false, error: `MPP payment failed: ${err.message}` };
  }

  stellarTxSubmittedTotal.inc({ result: "success" });
  paymentsUsdcTotal.inc({ type: "medication" });

  const spending = loadSpending(recipientId);

  const tx: Transaction = {
    id: `tx-${Date.now()}`, timestamp: new Date().toISOString(), type: "medication",
    description: `${drugName} from ${pharmacyName} [MPP Charge]`, amount, recipient: pharmacyId,
    stellarTxHash, mppOrderId, status: "completed", category: "medications",
  };

  spending.medications += amount;
  spending.transactions.push(tx);
  agentTransactionsTotal.inc({ status: "completed" });
  agentSpendingUsd.set({ category: "medications" }, spending.medications);
  saveSpending(recipientId, spending);

  // Schedule adherence reminder (#264)
  appendAdherenceRecord({
    recipientId,
    drug: drugName,
    pharmacy: pharmacyName,
    orderId: mppOrderId || tx.id,
    daysSupply: 30,
    orderedAt: new Date().toISOString(),
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    skippedCount: 0,
  });

  // Notify on high-value payments (#265)
  if (amount > NOTIFICATION_THRESHOLD) {
    notify({
      level: "info",
      title: "Medication Payment",
      description: `Paid $${amount} for ${drugName} from ${pharmacyName} for ${recipientId}.`,
      context: { recipientId, drug: drugName, pharmacy: pharmacyName, amount, txHash: stellarTxHash },
    });
  }

  return { success: true, transaction: tx };
}

// --- Tool: Pay a medical bill via Stellar USDC ---
export async function payBill(
  providerId: string, providerName: string, description: string, amount: number,
  skipApproval: boolean = false, recipientId: string = "rosa"
) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PAYMENT) {
    return { success: false, error: `Invalid payment amount: $${amount}. Amount must be a positive finite number <= $${MAX_PAYMENT}.` };
  }
  const policy = loadPolicyFor(recipientId);
  const policyCheck = checkSpendingPolicy(amount, "bills", recipientId);
  if (!policyCheck.allowed) {
    const reason = (policyCheck.reason || "").includes("daily") ? "daily_limit" : "budget";
    policyBlocksTotal.inc({ reason });
    return { success: false, error: `BLOCKED BY SPENDING POLICY: ${policyCheck.reason}` };
  }
  if (policyCheck.requiresApproval && !skipApproval) {
    policyBlocksTotal.inc({ reason: "approval_required" });
    const spending = loadSpending(recipientId);
    const tx: Transaction = {
      id: `tx-${Date.now()}`, timestamp: new Date().toISOString(), type: "bill",
      description: `${description} — ${providerName}`, amount, recipient: providerId,
      status: "pending", category: "bills",
    };
    spending.transactions.push(tx);
    agentTransactionsTotal.inc({ status: "pending" });
    saveSpending(recipientId, spending);
    return { success: false, error: `REQUIRES CAREGIVER APPROVAL: $${amount.toFixed(2)} exceeds the $${policy.approvalThreshold} approval threshold.`, transaction: tx };
  }

  const recipientKey = process.env.BILL_PROVIDER_PUBLIC_KEY;
  if (!recipientKey) return { success: false, error: "BILL_PROVIDER_PUBLIC_KEY not configured" };

  logger.info({ provider: providerName, amount }, "[Stellar] transferring USDC");

  let stellarTxHash: string | undefined;

  try {
    const account = await horizonServer.loadAccount(agentKeypair.publicKey());
    const usdcAsset = new Asset("USDC", USDC_ISSUER);

    const stellarTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: recipientKey,
          asset: usdcAsset,
          amount: amount.toFixed(7),
        })
      )
      .setTimeout(30)
      .build();

    stellarTx.sign(agentKeypair);

    const sigHint = stellarTx.signatures[0]?.hint();
    if (!sigHint || !sigHint.equals(agentKeypair.signatureHint())) {
      throw new Error(
        `Signer mismatch: expected ${agentKeypair.publicKey()} — refusing to submit`
      );
    }
    console.log(`  [Stellar] Signer verified: ${agentKeypair.publicKey().slice(0, 8)}...`);

    const result = await submitTransactionWithRetry(horizonServer, stellarTx);
    stellarTxHash = result.hash;
    logger.info({ txHash: stellarTxHash }, "[Stellar] TX confirmed");
  } catch (err: any) {
    stellarTxSubmittedTotal.inc({ result: "error" });
    const errorDetail = err?.response?.data?.extras?.result_codes || err.message;
    return { success: false, error: `Stellar USDC transfer failed: ${JSON.stringify(errorDetail)}` };
  }

  stellarTxSubmittedTotal.inc({ result: "success" });
  paymentsUsdcTotal.inc({ type: "bill" });

  const spending = loadSpending(recipientId);

  const tx: Transaction = {
    id: `tx-${Date.now()}`, timestamp: new Date().toISOString(), type: "bill",
    description: `${description} — ${providerName} [Stellar USDC]`, amount, recipient: providerId,
    stellarTxHash, status: "completed", category: "bills",
  };

  spending.bills += amount;
  spending.transactions.push(tx);
  agentTransactionsTotal.inc({ status: "completed" });
  agentSpendingUsd.set({ category: "bills" }, spending.bills);
  saveSpending(recipientId, spending);

  // Notify on high-value payments (#265)
  if (amount > NOTIFICATION_THRESHOLD) {
    notify({
      level: "info",
      title: "Bill Payment",
      description: `Paid $${amount} to ${providerName} for ${recipientId}: ${description}`,
      context: { recipientId, provider: providerName, amount, txHash: stellarTxHash },
    });
  }

  return { success: true, transaction: tx };
}

// --- Tool: Get spending summary ---
export function getSpendingSummary(recipientId: string = "rosa") {
  const spending = loadSpending(recipientId);
  const policy = loadPolicyFor(recipientId);
  const total = spending.medications + spending.bills + spending.serviceFees;
  return {
    recipientId,
    policy,
    spending: {
      medications: +spending.medications.toFixed(2),
      bills: +spending.bills.toFixed(2),
      serviceFees: +spending.serviceFees.toFixed(4),
      total: +total.toFixed(2),
    },
    budgetRemaining: {
      medications: +(policy.medicationMonthlyBudget - spending.medications).toFixed(2),
      bills: +(policy.billMonthlyBudget - spending.bills).toFixed(2),
    },
    transactionCount: spending.transactions.length,
    recentTransactions: spending.transactions.slice(-5),
  };
}

// --- Tool: Get wallet balance ---
export async function getWalletBalance() {
  const address = agentKeypair.publicKey();
  logger.info({ address }, "[Horizon] fetching wallet balance");

  try {
    const account = await horizonServer.loadAccount(address);
    
    const usdcBalance = account.balances.find(
      (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
    );
    
    const xlmBalance = account.balances.find(
      (b: any) => b.asset_type === "native"
    );

    return {
      address,
      balances: {
        usdc: usdcBalance ? parseFloat((usdcBalance as any).balance).toFixed(2) : "0.00",
        xlm: xlmBalance ? parseFloat((xlmBalance as any).balance).toFixed(2) : "0.00",
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    logger.error({ err: err.message, address }, "[Horizon] failed to fetch balance");
    throw new Error(`Failed to fetch wallet balance: ${err.message}`);
  }
}

// --- Tool: Generate dispute letter (#266) ---
export function generateDisputeLetter(
  billId: string,
  errorIds: string[],
  auditResult: { totalOvercharge: number; errorCount: number; lineItems: Array<{ description: string; cptCode?: string; chargedAmount: number; suggestedAmount?: number; errorDescription?: string }> },
  recipientInfo: { name: string; facility: string; caregiverName: string; caregiverEmail: string }
) {
  const errorItems = auditResult.lineItems.filter(
    (item) => errorIds.length === 0 || errorIds.includes(item.description)
  );

  const letterLines: string[] = [];
  letterLines.push(`Dear ${recipientInfo.facility} Billing Department,`);
  letterLines.push("");
  letterLines.push(`I am writing on behalf of ${recipientInfo.name}, a patient at your facility, to formally dispute the following billing errors identified in Bill #${billId}.`);
  letterLines.push("");
  letterLines.push("After auditing the bill, we found the following discrepancies:");
  letterLines.push("");

  for (const item of errorItems) {
    letterLines.push(`  - ${item.description}${item.cptCode ? ` (CPT: ${item.cptCode})` : ""}: Charged $${item.chargedAmount.toFixed(2)}`);
    if (item.suggestedAmount !== undefined) {
      letterLines.push(`    Fair market rate: $${item.suggestedAmount.toFixed(2)}`);
    }
    if (item.errorDescription) {
      letterLines.push(`    Issue: ${item.errorDescription}`);
    }
    letterLines.push("");
  }

  letterLines.push(`Total overcharge identified: $${auditResult.totalOvercharge.toFixed(2)}`);
  letterLines.push("");
  letterLines.push("We request that these charges be reviewed and corrected. Please adjust the bill to reflect the fair-market rates as outlined above.");
  letterLines.push("");
  letterLines.push("Thank you for your prompt attention to this matter.");
  letterLines.push("");
  letterLines.push("Sincerely,");
  letterLines.push(recipientInfo.caregiverName);
  letterLines.push(recipientInfo.caregiverEmail);

  const emailBody = letterLines.join("\n");

  // Generate HTML email version
  const htmlItems = errorItems.map((item) =>
    `<li><strong>${item.description}</strong>${item.cptCode ? ` (CPT: ${item.cptCode})` : ""}: Charged $${item.chargedAmount.toFixed(2)}${item.suggestedAmount !== undefined ? ` — Fair rate: $${item.suggestedAmount.toFixed(2)}` : ""}${item.errorDescription ? `<br/><em>${item.errorDescription}</em>` : ""}</li>`
  ).join("");

  const htmlBody = `
<h2>Medical Bill Dispute — #${billId}</h2>
<p>Dear ${recipientInfo.facility} Billing Department,</p>
<p>I am writing on behalf of <strong>${recipientInfo.name}</strong> to formally dispute billing errors in Bill #${billId}.</p>
<h3>Discrepancies Found:</h3>
<ul>${htmlItems}</ul>
<p><strong>Total overcharge: $${auditResult.totalOvercharge.toFixed(2)}</strong></p>
<p>We request these charges be reviewed and corrected to fair-market rates.</p>
<p>Sincerely,<br/>${recipientInfo.caregiverName}<br/>${recipientInfo.caregiverEmail}</p>
`.trim();

  return {
    billId,
    recipientName: recipientInfo.name,
    facility: recipientInfo.facility,
    totalOvercharge: auditResult.totalOvercharge,
    errorCount: errorItems.length,
    emailText: emailBody,
    emailHtml: htmlBody,
    generatedAt: new Date().toISOString(),
  };
}

// --- Tool: Get adherence status (#264) ---
export function getAdherenceStatus(recipientId: string = "rosa") {
  const summary = getAdherenceSummary(recipientId);
  const pending = getPendingAdherences(recipientId);
  const flagged = getFlaggedAdherences(recipientId);
  return { ...summary, pendingReminders: pending.length, flaggedReminders: flagged };
}

// --- Tool: Confirm adherence (#264) ---
export function confirmAdherenceReminder(recordId: string) {
  return { success: confirmAdherence(recordId) };
}

// Agent tool definitions
export const TOOL_DEFINITIONS = [
  {
    name: "compare_pharmacy_prices",
    description: "Compare medication prices across multiple pharmacies. Pays $0.002 USDC per query via x402 on Stellar. Returns prices sorted cheapest to most expensive, with potential savings.",
    input_schema: {
      type: "object" as const,
      properties: {
        drug_name: { type: "string", description: "Name of the medication (e.g., Lisinopril, Metformin)" },
        zip_code: { type: "string", description: "ZIP code for pharmacy location (default: 90210)" },
      },
      required: ["drug_name"],
    },
  },
  {
    name: "audit_medical_bill",
    description: "Audit a medical bill for errors (duplicates, upcoding, overcharges). 80% of medical bills contain errors. Pays $0.01 USDC per audit via x402 on Stellar. Pass line_items as a JSON string array of objects with fields: description, cptCode, quantity, chargedAmount.",
    input_schema: {
      type: "object" as const,
      properties: {
        line_items_json: {
          type: "string",
          description: "JSON string of line items array. Each item: {\"description\":\"...\",\"cptCode\":\"...\",\"quantity\":1,\"chargedAmount\":100}",
        },
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: ["line_items_json"],
    },
  },
  {
    name: "check_drug_interactions",
    description: "Check for drug-drug interactions. Pays $0.001 USDC per check via x402 on Stellar. Returns severity levels and clinical recommendations.",
    input_schema: {
      type: "object" as const,
      properties: {
        medications: { type: "array", items: { type: "string" }, description: "List of medication names" },
      },
      required: ["medications"],
    },
  },
  {
    name: "pay_for_medication",
    description: "Pay a pharmacy for a medication order via MPP Charge on Stellar (real USDC payment). Subject to spending policy limits. Automatically schedules an adherence reminder.",
    input_schema: {
      type: "object" as const,
      properties: {
        pharmacy_id: { type: "string" }, pharmacy_name: { type: "string" },
        drug_name: { type: "string" }, amount: { type: "number" },
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: ["pharmacy_id", "pharmacy_name", "drug_name", "amount"],
    },
  },
  {
    name: "pay_bill",
    description: "Pay a medical bill via direct Stellar USDC transfer. Subject to spending policy limits. If the bill has been audited and errors found, pay only the corrected amount.",
    input_schema: {
      type: "object" as const,
      properties: {
        provider_id: { type: "string" }, provider_name: { type: "string" },
        description: { type: "string" }, amount: { type: "number" },
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: ["provider_id", "provider_name", "description", "amount"],
    },
  },
  {
    name: "check_spending_policy",
    description: "Check if a payment amount is within the caregiver-set spending policy limits before attempting payment.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount: { type: "number" }, category: { type: "string", enum: ["medications", "bills"] },
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: ["amount", "category"],
    },
  },
  {
    name: "fetch_rosa_bill",
    description: "Fetch Rosa Garcia's hospital bill from General Hospital. Returns the bill with line items including CPT codes and charged amounts.",
    input_schema: {
      type: "object" as const,
      properties: {
        _unused: { type: "string", description: "Not used. Pass empty string." },
      },
      required: [] as string[],
    },
  },
  {
    name: "fetch_and_audit_bill",
    description: "Fetch Rosa's hospital bill from General Hospital AND audit it for errors in one step. Pays $0.01 USDC via x402. Returns the audit results with errors found, overcharges, and corrected total.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: [] as string[],
    },
  },
  {
    name: "get_spending_summary",
    description: "Get current spending summary for a recipient: total spent, budget remaining per category, recent transactions with Stellar tx hashes.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: [] as string[],
    },
  },
  {
    name: "get_wallet_balance",
    description: "Get the current on-chain wallet balance (USDC and XLM) from Stellar Horizon. Returns real-time balance data.",
    input_schema: {
      type: "object" as const,
      properties: {
        _unused: { type: "string", description: "Not used. Pass empty string." },
      },
      required: [] as string[],
    },
  },
  {
    name: "generate_dispute_letter",
    description: "Generate a dispute letter (PDF + email-ready text) for billing errors found during audit. Includes audit findings, fair-market rates, CPT codes, and caregiver contact info.",
    input_schema: {
      type: "object" as const,
      properties: {
        bill_id: { type: "string", description: "Bill identifier to dispute" },
        error_descriptions: {
          type: "array", items: { type: "string" },
          description: "List of error descriptions to dispute (empty = all errors)",
        },
        audit_result_json: {
          type: "string",
          description: "JSON string of the audit result containing lineItems, totalOvercharge, errorCount",
        },
        recipient_name: { type: "string", description: "Patient name" },
        facility: { type: "string", description: "Medical facility name" },
        caregiver_name: { type: "string", description: "Caregiver name" },
        caregiver_email: { type: "string", description: "Caregiver email" },
      },
      required: ["bill_id", "audit_result_json", "recipient_name", "facility", "caregiver_name", "caregiver_email"],
    },
  },
  {
    name: "get_adherence_status",
    description: "Get medication adherence status for a recipient — pending reminders, confirmed doses, skipped doses, and flagged persistent skips.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient_id: { type: "string", description: "Recipient identifier (default: rosa)" },
      },
      required: [] as string[],
    },
  },
  {
    name: "confirm_adherence",
    description: "Confirm that a medication dose was taken. Call this when the caregiver reports the recipient took their medication.",
    input_schema: {
      type: "object" as const,
      properties: {
        record_id: { type: "string", description: "Adherence record ID to confirm" },
      },
      required: ["record_id"],
    },
  },
];
