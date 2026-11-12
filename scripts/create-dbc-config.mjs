// One-time setup: creates YOUR launchpad's bonding-curve config on Solana (the "config key").
// Run on your own computer, never on the server. Your keypair signs locally and is never uploaded.
//
//   SOLANA_RPC_URL=https://api.devnet.solana.com KEYPAIR_PATH=./owner.json THRESHOLD_SOL=2 npm run launch:config
//
// Test on DEVNET first. Then put the printed config key into Vercel as DBC_CONFIG_KEY.
// Values below mimic pump.fun (1B supply, ~85 SOL to graduate); change them before mainnet.
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const kpPath = process.env.KEYPAIR_PATH;
if (!kpPath) { console.error("Set KEYPAIR_PATH to your Solana keypair JSON (array of 64 numbers)."); process.exit(1); }
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
const feeClaimer = new PublicKey(process.env.FEE_CLAIMER || owner.publicKey.toBase58());   // gets your platform trading fees
const connection = new Connection(rpc, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");
const config = Keypair.generate();

const tx = await client.partner.buildCurveAndCreateConfig({
  buildCurveParam: {
    totalTokenSupply: 1_000_000_000,
    percentageSupplyOnMigration: 20,                       // % of supply that goes to the DEX pool at graduation
    migrationQuoteThreshold: Number(process.env.THRESHOLD_SOL || 85), // SOL needed to graduate (use 1-2 on devnet)
    migrationOption: 1,                                    // 1 = Meteora DAMM v2
    tokenBaseDecimal: 6, tokenQuoteDecimal: 9,
    lockedVesting: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
    feeSchedulerParam: { numberOfPeriod: 0, reductionFactor: 0, periodFrequency: 0, feeSchedulerMode: 0 },
    baseFeeBps: Number(process.env.FEE_BPS || 100),        // 1% trading fee
    dynamicFeeEnabled: false,
    activationType: 1, collectFeeMode: 0, migrationFeeOption: 2, tokenType: 0,
    partnerLpPercentage: 0, creatorLpPercentage: 0,
    partnerLockedLpPercentage: 50, creatorLockedLpPercentage: 50,   // LP locked forever: nobody can pull the liquidity
    creatorTradingFeePercentage: 0
  },
  feeClaimer, leftoverReceiver: feeClaimer, payer: owner.publicKey,
  quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
  config: config.publicKey
});
const bh = await connection.getLatestBlockhash("confirmed");
tx.feePayer = owner.publicKey; tx.recentBlockhash = bh.blockhash;
tx.sign(owner, config);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log("\nDone. tx:", sig, "\nDBC_CONFIG_KEY =", config.publicKey.toBase58(), "\nPut this value in Vercel env vars.");
