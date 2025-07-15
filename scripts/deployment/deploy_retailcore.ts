import { ethers, upgrades, run, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

/* ---------- CONFIG (edit per network) --------------- */
const KING_ADDRESS = "0x8F08B70456eb22f6109F57b8fafE862ED28E6040";
const DEPOSIT_FEE_BPS = 0; // 0 %
const UNWRAP_FEE_BPS = 0; // 0 %
const EPOCH_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

/* per-token limits */
const LIMITS: Record<string, bigint> = {
  "0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB": ethers.parseEther("100000"), //ethfi
  "0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83": ethers.parseEther("150000"), //eigen
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": ethers.parseEther("200000"), //weth but need to be alt 
  "0x0a6E7Ba5042B38349e437ec6Db6214AEC7B35676": ethers.parseEther("500000"), //swell
};
/* ---------------------------------------------------- */

async function main() {
  const admin = "0xF46D3734564ef9a5a16fC3B1216831a28f78e2B5"; // replace with your deployer address
  console.log(`Deployer / admin: ${admin}`);
  console.log(`Network:          ${network.name}`);

  /* 1. deploy proxy */
  const RetailCore = await ethers.getContractFactory("RetailCore");
  const proxy: any = await upgrades.deployProxy(
    RetailCore,
    [KING_ADDRESS, admin, DEPOSIT_FEE_BPS, UNWRAP_FEE_BPS, EPOCH_SECONDS],
    { initializer: "initialize", kind: "transparent" },
  );
  await proxy.waitForDeployment();

  const proxyAddr = await proxy.getAddress();
  const implAddr = await upgrades.erc1967.getImplementationAddress(proxy.target);
  console.log("RetailCore proxy deployed  :", proxyAddr);
  console.log("RetailCore implementation  :", implAddr);

  // /* 2. verify implementation automatically */
  // console.log("Waiting 6 block confirmations before verification…");
  // await proxy.deploymentTransaction()?.wait(6);

  // console.log("Verifying implementation on Etherscan…");
  // try {
  //   await run("verify:verify", {
  //     address: implAddr,
  //     constructorArguments: [],
  //   });
  //   console.log("✓ Verified");
  // } catch (e: any) {
  //   console.log("Verification skipped / failed:", e.message || e);
  // }

  /* 3. wire basic params inside RetailCore */

  const adminSigner = new ethers.Wallet(process.env.ADMIN_SIGNER_PRIVATE_KEY || "", ethers.provider);
  const retail = await ethers.getContractAt("RetailCore", proxyAddr, adminSigner);

  /* 3a. set per-token limits */
  await (await retail.setDepositLimits(Object.keys(LIMITS), Object.values(LIMITS))).wait();
  console.log("Deposit limits set");

  /* 3b. sanity output */
  const cfg = await retail.getGlobalConfig();
  console.log("depositFeeBps:", cfg.depositFeeBpsValue.toString());
  console.log("unwrapFeeBps :", cfg.unwrapFeeBpsValue.toString());
  console.log("epochSeconds :", cfg.epochDurationValue.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
