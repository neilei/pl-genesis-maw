/**
 * Transfer all USDFC from farm wallets to the main Filecoin wallet.
 * Accepts optional --keys flag to filter which keys to process,
 * or processes all keys if no flag given.
 *
 * Usage: node packages/agent/scripts/farm-transfer.mjs
 *        node packages/agent/scripts/farm-transfer.mjs --keys 0,1,2
 */

import { createWalletClient, createPublicClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filecoinCalibration } from "viem/chains";

const MAIN_WALLET = "0x4F12c98c004Ff28aA1e3C230946A89430F5889F0";
const USDFC_CONTRACT = "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0";
const RPC_URL = "https://rpc.ankr.com/filecoin_testnet";

const ALL_FARM_KEYS = [
  // Original 3
  "0x4d7c33113820cdd5a74b0118ccbf3ae8dd7c43221d91ed366ed86f6e2b171d9a",
  "0x9bcb1c834b2e01cab4213e1c67a89748ca3453fdddf486f29909b4f2676d933c",
  "0xb083bbaf1f517860bb75ac0a5084d3f1a464e6d3cfef25a41eccc17f0a1300a7",
  // New 20
  "0x64683d79e704466294c60117515ca98671dbcf3fcb5ae73f732e2314a432c6e7",
  "0xbf46727f5778ec0afb7e6487ac7cd7b8ba9351b4f69a1f604966ac630bef0024",
  "0xb362a0ec15402d409c45e26a085054fe5ae2e6a40266899440a1183210c014b9",
  "0xab063f16b4d3e3b9fb40b5563358484ae0509d65277c9ef8deeac3b16b6ebbfb",
  "0x5f169dc630eeceeea41499b31d0c7ce505cc1e3aae753c59b1783286dfdc475d",
  "0x16df7c61e2402d41ba70037346784f433801d8a77f40b905c73fb4f1a8496366",
  "0x9ca67c7aeed5503e126ff6761cf4e63b91a13c58c6799428f0ceefcb6138cc07",
  "0x1ea769d059c78988bf87171c3f09cd916b4c2e224ec4685fa3efb78fbcaf2366",
  "0x128eea6d0dc6df5a115942fdd8ad484b904b5fbb389104a5f8a142b966db1092",
  "0x75767c4ddad14fcccab1291efb3cd417486136d82f7167a43e0acbd2c2fc2d2b",
  "0x516446ca54eed271b098ce170f038046eb42ce46217bcff4074bd669fa071dd3",
  "0x24a37136f52f7d64b6dcb523cc63ee821ee05fce29f814182cfd9a9cc4d63d0b",
  "0x291080a691f105aaa928cb8ebe7b054e8f3bd18c5a2dea4eb093dd95e517fe10",
  "0xdade0e33f07b6917744dd0da18a969691d21a93a91213703bba403c501e99754",
  "0x14b5384967f59d6b167a9492b764abfb73e3a4f23bb61335f2a9c088b62297be",
  "0x560dea66c5271fee517663891cd385ef5cf91a27d3cb0dcb49aeef893268a3d1",
  "0x68476e4823aebf05235eb258f74dc1b44212dad70a05db89a34939a27acc6f77",
  "0xa03c10e7da12c8ad3d0cb404c3f4c3f96c25eac99a943b6316530f81545f556f",
  "0x1a9dac85beb82ae4d354e5f4dbab441c05d2223f723fdfe8e7675e2cf0fe6377",
  "0xebfe7c55b6620e1347358257ae45a460ab91c66803508ab8ea6fc67b8a149650",
];

// Parse --keys flag for subset processing
const keysArg = process.argv.find((a) => a.startsWith("--keys="));
const keysFilter = keysArg
  ? keysArg.split("=")[1].split(",").map(Number)
  : null;
const farmKeys = keysFilter
  ? keysFilter.map((i) => ALL_FARM_KEYS[i]).filter(Boolean)
  : ALL_FARM_KEYS;

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const ts = () => new Date().toISOString().replace(/\.\d+Z/, "Z");

const pub = createPublicClient({
  chain: filecoinCalibration,
  transport: http(RPC_URL),
});

// Process all wallets concurrently with concurrency limit
const CONCURRENCY = 5;
let totalTransferred = 0n;

async function transferOne(pk) {
  const account = privateKeyToAccount(pk);
  const addr = account.address.slice(0, 10);
  try {
    const balance = await pub.readContract({
      address: USDFC_CONTRACT,
      abi,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (balance === 0n) {
      console.log(`${ts()} [SKIP] ${addr}... balance=0`);
      return 0n;
    }

    const filBalance = await pub.getBalance({ address: account.address });
    if (filBalance === 0n) {
      console.log(`${ts()} [SKIP] ${addr}... has ${formatUnits(balance, 18)} USDFC but 0 FIL (no gas)`);
      return 0n;
    }

    const wallet = createWalletClient({
      account,
      chain: filecoinCalibration,
      transport: http(RPC_URL),
    });

    const hash = await wallet.writeContract({
      address: USDFC_CONTRACT,
      abi,
      functionName: "transfer",
      args: [MAIN_WALLET, balance],
    });

    console.log(`${ts()} [OK] ${addr}... transferred ${formatUnits(balance, 18)} USDFC tx=${hash}`);
    return balance;
  } catch (err) {
    console.log(`${ts()} [FAIL] ${addr}... ${err.message?.slice(0, 200)}`);
    return 0n;
  }
}

// Run with concurrency limit
const queue = [...farmKeys];
const running = new Set();

async function runNext() {
  if (queue.length === 0) return;
  const pk = queue.shift();
  const p = transferOne(pk).then((amt) => {
    totalTransferred += amt;
    running.delete(p);
  });
  running.add(p);
  if (running.size >= CONCURRENCY) {
    await Promise.race(running);
  }
  await runNext();
}

await runNext();
await Promise.all(running);

if (totalTransferred > 0n) {
  console.log(`${ts()} Total transferred: ${formatUnits(totalTransferred, 18)} USDFC`);
} else {
  console.log(`${ts()} No USDFC to transfer`);
}
