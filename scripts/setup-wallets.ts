/**
 * Setup script: Creates and funds Stellar testnet wallets for CareGuard
 *
 * Creates wallets for: agent, caregiver, 3 pharmacies, bill provider
 * Funds each with XLM via Friendbot, creates USDC trustlines
 */

import { Keypair, Networks, TransactionBuilder, Operation, Asset, Horizon } from "@stellar/stellar-sdk";
import { logger } from "../shared/logger.ts";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

interface WalletInfo {
  name: string;
  publicKey: string;
  secretKey: string;
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!response.ok) {
    const text = await response.text();
    // Friendbot returns an error if already funded, which is fine
    if (!text.includes("createAccountAlreadyExist")) {
      throw new Error(`Friendbot failed for ${publicKey}: ${text}`);
    }
  }
}

async function addUsdcTrustline(keypair: Keypair): Promise<void> {
  const server = new Horizon.Server(HORIZON_URL);
  const account = await server.loadAccount(keypair.publicKey());

  const usdc = new Asset("USDC", USDC_ISSUER);

  // Check if trustline already exists
  const hasTrustline = account.balances.some(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );

  if (hasTrustline) {
    logger.info({ wallet: keypair.publicKey().slice(0, 8) }, "USDC trustline already exists");
    return;
  }

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  await server.submitTransaction(tx);
  logger.info({ wallet: keypair.publicKey().slice(0, 8) }, "USDC trustline added");
}

async function main() {
  const writeEnv = process.argv.includes("--write-env");
  logger.info("CareGuard Wallet Setup starting");

  const wallets: WalletInfo[] = [
    { name: "AGENT", ...generateKeypair() },
    { name: "CAREGIVER", ...generateKeypair() },
    { name: "PHARMACY_1", ...generateKeypair() },
    { name: "PHARMACY_2", ...generateKeypair() },
    { name: "PHARMACY_3", ...generateKeypair() },
    { name: "BILL_PROVIDER", ...generateKeypair() },
  ];

  logger.info("step 1: funding accounts via Friendbot");
  for (const wallet of wallets) {
    try {
      await fundAccount(wallet.publicKey);
      logger.info({ name: wallet.name, wallet: wallet.publicKey.slice(0, 8) }, "funded");
    } catch (err: any) {
      logger.error({ name: wallet.name, err: err.message }, "failed to fund wallet");
    }
  }

  logger.info("step 2: adding USDC trustlines");
  for (const wallet of wallets) {
    try {
      const keypair = Keypair.fromSecret(wallet.secretKey);
      await addUsdcTrustline(keypair);
    } catch (err: any) {
      logger.error({ name: wallet.name, err: err.message }, "failed to add trustline");
    }
  }

  // Step 3: Output .env values — written directly so they are copy-pasteable
  const envLines: string[] = [];
  for (const wallet of wallets) {
    envLines.push(`${wallet.name}_SECRET_KEY=${wallet.secretKey}`);
    envLines.push(`${wallet.name}_PUBLIC_KEY=${wallet.publicKey}`);
  }
  envLines.push(`\n# USDC Testnet\nUSDC_ISSUER=${USDC_ISSUER}`);

  if (writeEnv) {
    const confirmMsg = "Write these values to .env in the current directory? (y/N) ";
    process.stdout.write(confirmMsg);
    const answer = await new Promise<string>((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()));
    });
    if (answer === "y" || answer === "yes") {
      const fs = await import("fs");
      const existing = fs.existsSync(".env") ? fs.readFileSync(".env", "utf-8") : "";
      const updated = existing + (existing.endsWith("\n") ? "" : "\n") + envLines.join("\n") + "\n";
      fs.writeFileSync(".env", updated);
      logger.info(".env file updated");
    } else {
      logger.info("Skipped writing .env");
    }
  }

  process.stdout.write("\n=== Add these to your .env file ===\n\n");
  for (const line of envLines) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write(`\n=== IMPORTANT ===\nNow get testnet USDC for the AGENT wallet:\n`);
  process.stdout.write(`1. Go to https://faucet.circle.com\n2. Select "Stellar Testnet"\n`);
  process.stdout.write(`3. Paste the AGENT public key: ${wallets[0].publicKey}\n`);
  process.stdout.write(`4. Request USDC (you'll get 100 USDC)\n\nAlso fund the CAREGIVER wallet with USDC for testing.\n`);
}

function generateKeypair(): { publicKey: string; secretKey: string } {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secretKey: kp.secret() };
}

main().catch((err) => { logger.error({ err: err?.message ?? err }, "setup failed"); process.exit(1); });
