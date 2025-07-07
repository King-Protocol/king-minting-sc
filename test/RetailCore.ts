import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { parseEther, MaxUint256, ZeroAddress, parseUnits } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { impersonateAccount, setBalance, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { IERC20, IKing, RetailCore, RetailCore__factory } from "../typechain-types";

/* ───── constants ───── */
const KING_ADDRESS = "0x8F08B70456eb22f6109F57b8fafE862ED28E6040";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; 
const TOKENS = {
  ETHFI: "0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB",
  EIGEN: "0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83",
  ALT: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  SWELL: "0x0a6E7Ba5042B38349e437ec6Db6214AEC7B35676",
} as const;
const LIMITS: Record<string, bigint> = {
  [TOKENS.ETHFI]: parseEther("100000"),
  [TOKENS.EIGEN]: parseEther("150000"),
  [TOKENS.ALT]: parseEther("200000"),
  [TOKENS.SWELL]: parseEther("500000"),
};
const WHALES = [
  "0x95Bf94e06D5BE1000C23cd99968eff414Aa4995e",
  "0x5f556Cc5C294D7D3EfFaFFeb0B1195256a7A19D7",
  "0x6B44ba0a126a2A1a8aa6cD1AdeeD002e141Bcd44",
  "0x9ae383C2bc1c4B21a774237DD16B57cc67Df875e",
];
const DEPOSIT_FEE_BPS = 100;
const UNWRAP_FEE_BPS = 100;
const EPOCH_DURATION_S = 3600; //1 minute

/* helper to impersonate whales */
async function imp(addr: string) {
  await setBalance(addr, parseEther("10"));
  await impersonateAccount(addr);
  return ethers.getSigner(addr);
}

/* ───── variables ───── */
let deployer: SignerWithAddress,
  admin: SignerWithAddress,
  user1: SignerWithAddress,
  user2: SignerWithAddress,
  user3: SignerWithAddress,
  user4: SignerWithAddress;

let snapshotA: SnapshotRestorer;
let king: IKing, retail: RetailCore, weth: IERC20, ethfi: IERC20, swell: IERC20, eigen: IERC20;

describe("RetailCore", () => {
  before(async () => {
    /* signers */
    [deployer] = await ethers.getSigners();
    admin = deployer; // <- admin — тот же, что и deployer

    /* connect real King */
    king = (await ethers.getContractAt("IKing", KING_ADDRESS, deployer)) as IKing;
    const gov = await imp(await king.governor());

    /* deploy RetailCore behind transparent proxy */
    const RetailCoreFactory = await ethers.getContractFactory("RetailCore", deployer);

    retail = (await upgrades.deployProxy(
      RetailCoreFactory,
      [king.target, admin.address, DEPOSIT_FEE_BPS, UNWRAP_FEE_BPS, EPOCH_DURATION_S],
      { initializer: "initialize", kind: "transparent" },
    )) as RetailCore;

    /* whitelist RetailCore in King */
    await king.connect(gov).setDepositors([retail.target], [true]); // bool-массив

    /* set per-token limits */
    await retail.connect(admin).setDepositLimits(Object.values(TOKENS), Object.values(LIMITS));

    /* whale user */
    user1 = await imp(WHALES[0]); //ethfi
    user2 = await imp(WHALES[1]); //eigen
    user3 = await imp(WHALES[2]); //alt
    user4 = await imp(WHALES[3]); //swell

    weth = (await ethers.getContractAt("IERC20", TOKENS.ALT, user3)) as IERC20;
    ethfi = (await ethers.getContractAt("IERC20", TOKENS.ETHFI, user1)) as IERC20;
    eigen = (await ethers.getContractAt("IERC20", TOKENS.EIGEN, user1)) as IERC20;
    swell = (await ethers.getContractAt("IERC20", TOKENS.SWELL, user1)) as IERC20;

    await weth.connect(user1).approve(retail.target, MaxUint256);
    await weth.connect(user3).approve(retail.target, MaxUint256);
    await ethfi.connect(user1).approve(retail.target, MaxUint256);
    await ethfi.connect(user3).approve(retail.target, MaxUint256);
    await eigen.connect(user2).approve(retail.target, MaxUint256);
    await swell.connect(user4).approve(retail.target, MaxUint256);

    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    snapshotA = await takeSnapshot();
  });

  afterEach(async () => await snapshotA.restore());

  describe("Deployment", () => {
    it("should initialize correctly", async () => {
      expect(await retail.kingContract()).to.equal(KING_ADDRESS);
      expect(await retail.depositFeeBps()).to.equal(DEPOSIT_FEE_BPS);
      expect(await retail.unwrapFeeBps()).to.equal(UNWRAP_FEE_BPS);
      expect(await retail.epochDuration()).to.equal(EPOCH_DURATION_S);
      expect(await retail.accruedFees()).to.equal(0);
    });

    it("zero address revert", async () => {
      const RetailCoreFactory2 = await ethers.getContractFactory("RetailCore", deployer);
      await expect(
        upgrades.deployProxy(
          RetailCoreFactory2,
          [ZeroAddress, admin.address, DEPOSIT_FEE_BPS, UNWRAP_FEE_BPS, EPOCH_DURATION_S],
          {
            initializer: "initialize",
            kind: "transparent",
          },
        ),
      ).to.be.revertedWithCustomError(retail, "ZeroAddress");

      await expect(
        upgrades.deployProxy(
          RetailCoreFactory2,
          [king.target, ZeroAddress, DEPOSIT_FEE_BPS, UNWRAP_FEE_BPS, EPOCH_DURATION_S],
          {
            initializer: "initialize",
            kind: "transparent",
          },
        ),
      ).to.be.revertedWithCustomError(retail, "ZeroAddress");
    });
  });

  /*************************************************
   *                  DEPOSIT                       *
   *************************************************/

  describe("Deposit", () => {
    const amount = parseEther("1");

    it("single-token happy path", async () => {
      const balUserBefore = await weth.balanceOf(user3.address);
      const balRetailBefore = await weth.balanceOf(retail.target);
      const kingBalanceBefore = await king.balanceOf(user3.address);

      const tx = await retail.connect(user3).depositMultiple([TOKENS.ALT], [amount]);
      await expect(tx).to.emit(retail, "Deposited");

      expect(await weth.balanceOf(user3.address)).to.equal(balUserBefore - amount);
      expect(await weth.balanceOf(retail.target)).to.equal(balRetailBefore); // forwarded into King
      expect(await retail.accruedFees()).to.be.gt(0);
      const kingAmt = await king.balanceOf(user3.address);
      expect(kingAmt).to.be.gt(kingBalanceBefore);

      const [limit, used] = await retail.getTokenDepositInfo(TOKENS.ALT);
      expect(used).to.equal(amount);
      expect(limit).to.equal(LIMITS[TOKENS.ALT]);

      const depositable = await retail.getDepositableTokens();
      expect(depositable).to.include(TOKENS.ALT);

      let [net] = await retail.previewDepositMultiple([TOKENS.ALT], [amount]);
      expect(net).to.be.eq(kingAmt);
      expect(net).to.be.gt(0);
    });

    it("deposit with automatic reset epoch", async () => {
      const balUserBefore = await weth.balanceOf(user3.address);
      const balRetailBefore = await weth.balanceOf(retail.target);
      const kingBalanceBefore = await king.balanceOf(user3.address);

      const newEpochDuration = 3600;
      await retail.setEpochDuration(newEpochDuration, true);
      await time.increase(EPOCH_DURATION_S + 1);

      const tx = await retail.connect(user3).depositMultiple([TOKENS.ALT], [amount]);
      await expect(tx).to.emit(retail, "Deposited");

      expect(await weth.balanceOf(user3.address)).to.equal(balUserBefore - amount);
      expect(await weth.balanceOf(retail.target)).to.equal(balRetailBefore);
      expect(await retail.accruedFees()).to.be.gt(0);
      const kingAmt = await king.balanceOf(user3.address);
      expect(kingAmt).to.be.gt(kingBalanceBefore);

      const [limit, used] = await retail.getTokenDepositInfo(TOKENS.ALT);
      expect(used).to.equal(amount);
      expect(limit).to.equal(LIMITS[TOKENS.ALT]);

      await time.increase(newEpochDuration + 5);

      const smallAmount = parseEther("0.0001");
      await retail.connect(user1).depositMultiple([TOKENS.ETHFI], [smallAmount]);

      const [limitAfter, usedAfter] = await retail.getTokenDepositInfo(TOKENS.ETHFI);
      expect(limitAfter).to.equal(LIMITS[TOKENS.ETHFI]);
      expect(usedAfter).to.equal(smallAmount);

      await retail.connect(user3).depositMultiple([TOKENS.ALT], [smallAmount]);

      const [limitAfter2, usedAfter2] = await retail.getTokenDepositInfo(TOKENS.ALT);
      expect(limitAfter2).to.equal(LIMITS[TOKENS.ALT]);
      expect(usedAfter2).to.equal(smallAmount);
    });

    it("deposit token with 0 allowed limit", async () => {
      await retail.connect(admin).setDepositLimits([TOKENS.ALT], [0n]);
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [amount])).to.be.revertedWithCustomError(
        retail,
        "DepositLimitExceeded",
      );
    });

    it("no dublicate token deposit", async () => {
      const tx = retail.connect(user3).depositMultiple([TOKENS.ALT, TOKENS.ALT], [amount, amount]);
      await expect(tx).to.be.revertedWithCustomError(retail, "DuplicateToken");
    });

    it("deposit with reset epoch", async () => {
      const balUserBefore = await weth.balanceOf(user3.address);
      const balRetailBefore = await weth.balanceOf(retail.target);
      const kingBalanceBefore = await king.balanceOf(user3.address);

      const [net] = await retail.previewDepositMultiple([TOKENS.ALT], [amount]);

      const tx = await retail.connect(user3).depositMultiple([TOKENS.ALT], [amount]);
      await expect(tx).to.emit(retail, "Deposited");

      expect(await weth.balanceOf(user3.address)).to.equal(balUserBefore - amount);
      expect(await weth.balanceOf(retail.target)).to.equal(balRetailBefore); // forwarded into King
      expect(await retail.accruedFees()).to.be.gt(0);
      const kingAmt = await king.balanceOf(user3.address);
      expect(kingAmt).to.be.gt(kingBalanceBefore);
      expect(net).to.be.eq(kingAmt);

      const [limit, used] = await retail.getTokenDepositInfo(TOKENS.ALT);
      expect(used).to.equal(amount);
      expect(limit).to.equal(LIMITS[TOKENS.ALT]);

      const depositable = await retail.getDepositableTokens();
      expect(depositable).to.include(TOKENS.ALT);

      await retail.connect(admin).resetEpoch();

      const [limitAfter, usedAfter] = await retail.getTokenDepositInfo(TOKENS.ALT);
      expect(usedAfter).to.equal(0);
      expect(limitAfter).to.equal(LIMITS[TOKENS.ALT]);
    });

    it("multi-token happy path", async () => {
      const half = amount / 2n;
      await weth.connect(user3).transfer(user1.address, half);
      const kingAmtBefore = await king.balanceOf(user1);

      await retail.connect(user1).depositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, half]);

      const kingAmt = await king.balanceOf(user1);
      expect(kingAmt).to.be.gt(kingAmtBefore);

      const [limit1, u1] = await retail.getTokenDepositInfo(TOKENS.ALT);
      const [limit2, u2] = await retail.getTokenDepositInfo(TOKENS.ETHFI);
      expect(u1).to.equal(half);
      expect(u2).to.equal(half);
      expect(limit1).to.equal(LIMITS[TOKENS.ALT]);
      expect(limit2).to.equal(LIMITS[TOKENS.ETHFI]);

      const [net] = await retail.previewDepositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, half]);
      expect(net).to.be.gt(0);
      expect(net).to.be.eq(kingAmt);
    });

    it("multi-token with zero amount", async () => {
      const half = amount / 2n;
      await weth.connect(user3).transfer(user1.address, half);
  

      const tx =retail.connect(user1).depositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, 0]);
      await expect(tx).to.be.revertedWithCustomError(retail, "InvalidAmount");
    
    });

    it("2x multi-token deposit but second exceeds limit revert", async () => {
      const half = amount / 2n;
      await weth.connect(user3).transfer(user1.address, half);
      const kingAmtBefore = await king.balanceOf(user1);

      await retail.connect(user1).depositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, half]);

      const kingAmt = await king.balanceOf(user1);
      expect(kingAmt).to.be.gt(kingAmtBefore);

      const [limit1, u1] = await retail.getTokenDepositInfo(TOKENS.ALT);
      const [limit2, u2] = await retail.getTokenDepositInfo(TOKENS.ETHFI);
      expect(u1).to.equal(half);
      expect(u2).to.equal(half);
      expect(limit1).to.equal(LIMITS[TOKENS.ALT]);
      expect(limit2).to.equal(LIMITS[TOKENS.ETHFI]);

      const [net, ,] = await retail.previewDepositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, half]);
      expect(net).to.be.gt(0);
      expect(net).to.be.eq(kingAmt);

      const fulfillLimit = parseEther("200000");
      const wethBalance = await weth.balanceOf(user3);
      await weth.connect(user3).transfer(user1.address, wethBalance);

      await expect(
        retail.connect(user1).depositMultiple([TOKENS.ALT, TOKENS.ETHFI], [fulfillLimit, 0]),
      ).to.be.revertedWithCustomError(retail, "DepositLimitExceeded");
    });
    
    it("reverts on single-token deposit with amount == 0", async () => {
      await expect(
          retail.connect(user3).depositMultiple([TOKENS.ALT], [0]),
        ).to.be.revertedWithCustomError(retail, "InvalidAmount");
      });
      
    it("reverts when ANY element in array is zero", async () => {
        const half = amount / 2n;
        await weth.connect(user3).transfer(user1.address, half);
      
        await expect(
          retail.connect(user1).depositMultiple([TOKENS.ALT, TOKENS.ETHFI], [half, 0]),
        ).to.be.revertedWithCustomError(retail, "InvalidAmount");
    });

    it("token not whitelisted revert while depositing", async () => {
      const half = amount / 2n;
      await weth.connect(user3).transfer(user1.address, half);
      const kingAmtBefore = await king.balanceOf(user1);

      await expect(
        retail.connect(user1).depositMultiple([TOKENS.ALT, admin.address], [half, half]),
      ).to.be.revertedWithCustomError(retail, "TokenNotWhitelisted");
    });

    it("length mismatch", async () => {
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [])).to.be.revertedWithCustomError(
        retail,
        "AssetArrayLengthMismatch",
      );
    });

    it("token paused", async () => {
      await retail.connect(admin).setTokenPause(TOKENS.ALT, true);
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [amount])).to.be.revertedWithCustomError(
        retail,
        "TokenPaused",
      );
    });

    it("global pause", async () => {
      await retail.connect(admin).pauseDeposits();
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [1])).to.be.revertedWithCustomError(
        retail,
        "EnforcedPause",
      );
    });

    it("exceeds limit revert", async () => {
      const amount = LIMITS[TOKENS.ALT] + 1n;
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [amount])).to.be.revertedWithCustomError(
        retail,
        "DepositLimitExceeded",
      );
    });

    it("token count zero revert", async () => {
      await expect(retail.connect(user3).depositMultiple([], [])).to.be.revertedWithCustomError(retail, "EmptyDeposit");
    });
  });

  /*************************************************
   *                  UNWRAP                       *
   *************************************************/
  describe("Unwrap", () => {
    const depAmt = parseEther("0.5");

    beforeEach(async () => {
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [depAmt]);
    });

    it("happy path", async () => {
      const kingAmt = await king.balanceOf(user3.address);
      const fee = (kingAmt * BigInt(UNWRAP_FEE_BPS)) / 10_000n;

      await king.connect(user3).approve(retail.target, kingAmt);
      const balBefore = await weth.balanceOf(user3.address);
      const accruedFeeBefore = await retail.accruedFees();

      const res = await retail.connect(user3).previewUnwrap(kingAmt);
      expect(res.feeAmount).to.be.gt(0);
      expect(res.kingFeeAmount).to.be.eq(0); //king contract set 0 fees
      expect(res.tokens).to.be.an("array").that.is.not.empty;
      expect(res.amounts).to.be.an("array").that.is.not.empty;

      const tx = await retail.connect(user3).unwrap(kingAmt);
      await expect(tx).to.emit(retail, "Unwrapped").withArgs(user3.address, kingAmt, fee);

      expect(await retail.accruedFees()).to.be.eq(accruedFeeBefore + fee);
      expect(await retail.accruedFees()).to.be.eq(accruedFeeBefore + res.feeAmount);
      expect(await king.balanceOf(user3.address)).to.equal(0);
      expect(await weth.balanceOf(user3.address)).to.be.gt(balBefore);
    });

    it("zero amount revert", async () => {
      await expect(retail.connect(user3).unwrap(0)).to.be.revertedWithCustomError(retail, "InvalidAmount");
    });
  });

  /*************************************************
   *                  SETTERS                      *
   *************************************************/
  describe("Setters", () => {
    it("update fees", async () => {
      const newFee = 400;
      const tx = await retail.connect(admin).setDepositFeeBps(newFee);
      await expect(tx).to.emit(retail, "FeesSet").withArgs(newFee, UNWRAP_FEE_BPS);
      expect((await retail.getGlobalConfig()).depositFeeBpsValue).to.equal(newFee);
    });

    it("unwrap fee too big revert", async () => {
      await expect(retail.connect(admin).setUnwrapFeeBps(9001)).to.be.revertedWithCustomError(
        retail,
        "UnwrapFeeTooBig",
      );
    });

    it("epoch duration reset", async () => {
      const tx = await retail.connect(admin).setEpochDuration(EPOCH_DURATION_S * 2, true);
      await expect(tx).to.emit(retail, "EpochDurationSet");
      expect((await retail.getEpochInfo()).duration).to.equal(EPOCH_DURATION_S * 2);
    });

    it("invalid epoch duration set revert", async () => {
      await expect(retail.connect(admin).setEpochDuration(0, true)).to.be.revertedWithCustomError(
        retail,
        "InvalidEpochDuration",
      );
    });

    it("set token pause", async () => {
      const tx = await retail.connect(admin).setTokenPause(TOKENS.ALT, true);
      await expect(tx).to.emit(retail, "TokenPauseChanged").withArgs(TOKENS.ALT, true);
      expect(await retail.isTokenPaused(TOKENS.ALT)).to.equal(true);

      const tx2 = await retail.connect(admin).setTokenPause(TOKENS.ALT, false);
      await expect(tx2).to.emit(retail, "TokenPauseChanged").withArgs(TOKENS.ALT, false);
      expect(await retail.isTokenPaused(TOKENS.ALT)).to.equal(false);
    });

    it("set token pause already in this state revert", async () => {
      const tx = await retail.connect(admin).setTokenPause(TOKENS.ALT, true);
      await expect(tx).to.emit(retail, "TokenPauseChanged").withArgs(TOKENS.ALT, true);
      expect(await retail.isTokenPaused(TOKENS.ALT)).to.equal(true);

      await expect(retail.connect(admin).setTokenPause(TOKENS.ALT, true)).to.be.revertedWithCustomError(
        retail,
        "AlreadyInThisState",
      );
    });

    it("only whitelisted tokens revert", async () => {
      await expect(retail.setTokenPause(admin, true)).to.be.revertedWithCustomError(retail, "TokenNotWhitelisted");
    });

    it("only admin role revert", async () => {
      await expect(retail.connect(user3).setTokenPause(TOKENS.ALT, true)).to.be.reverted;

      await expect(retail.connect(user3).setDepositFeeBps(123)).to.be.reverted;

      await expect(retail.connect(user3).setUnwrapFeeBps(123)).to.be.reverted;

      await expect(retail.connect(user3).setEpochDuration(EPOCH_DURATION_S / 2, true)).to.be.reverted;

      await expect(retail.connect(user3).setDepositLimits([TOKENS.ALT], [parseEther("1")])).to.be.reverted;

      await expect(retail.connect(user3).pauseDeposits()).to.be.reverted;

      await expect(retail.connect(user3).unpauseDeposits()).to.be.reverted;

      await expect(retail.connect(user3).withdrawFees(1)).to.be.reverted;

      await expect(retail.connect(user3).resetEpoch()).to.be.reverted;
    });

    it("set deposit limits asset array length mismatch revert", async () => {
      await expect(
        retail.connect(admin).setDepositLimits([TOKENS.ALT, TOKENS.ETHFI], [parseEther("1")]),
      ).to.be.revertedWithCustomError(retail, "AssetArrayLengthMismatch");
    });

    it("set deposit fee to big revert", async () => {
      await expect(retail.connect(admin).setDepositFeeBps(9001)).to.be.revertedWithCustomError(
        retail,
        "DepositFeeTooBig",
      );
    });

    it("allows setting fee exactly MAX_FEE_VALUE, but >MAX reverts", async () => {
      const MAX = await retail.MAX_FEE_VALUE();

      await expect(retail.connect(admin).setDepositFeeBps(MAX)).to.not.be.reverted;
      expect((await retail.getGlobalConfig()).depositFeeBpsValue).to.equal(MAX);
      await expect(retail.connect(admin).setDepositFeeBps(MAX + 1n)).to.be.revertedWithCustomError(
        retail,
        "DepositFeeTooBig",
      );
      await expect(retail.connect(admin).setUnwrapFeeBps(MAX)).to.not.be.reverted;
      expect((await retail.getGlobalConfig()).unwrapFeeBpsValue).to.equal(MAX);
      await expect(retail.connect(admin).setUnwrapFeeBps(MAX + 1n)).to.be.revertedWithCustomError(
        retail,
        "UnwrapFeeTooBig",
      );
    });

    it("epochDuration < 1 hour or > 30 days reverts", async () => {
      const ONE_HOUR = 60 * 60;
      const THIRTY_DAYS = 30 * 24 * 60 * 60;
      await expect(
        retail.connect(admin).setEpochDuration(ONE_HOUR - 1, false),
      ).to.be.revertedWithCustomError(retail, "InvalidEpochDuration");

      await expect(
        retail.connect(admin).setEpochDuration(THIRTY_DAYS + 1, false),
      ).to.be.revertedWithCustomError(retail, "InvalidEpochDuration");
    });



    it("allows a very small (dust) deposit that still mints >0 KING", async () => {
      const tiny = 1n;
      const preview = await retail.previewDepositMultiple([TOKENS.ALT], [tiny]);
      if (preview.kingToReceiveNet > 0n) {
        await weth.connect(user3).transfer(user2, tiny);
        await weth.connect(user2).approve(retail.target, MaxUint256);
        await expect(retail.connect(user2).depositMultiple([TOKENS.ALT], [tiny])).to.not.be
          .reverted;
      }
    });
      
    it("reverts with DepositTooSmall when King mints zero", async () => {
      let amt = 1n;
      for (let i = 0; i < 32; i++) {
        const p = await retail.previewDepositMultiple([TOKENS.ALT], [amt]);
        if (p.kingToReceiveNet === 0n) {
          await weth.connect(user3).transfer(user2, amt);
          await weth.connect(user2).approve(retail.target, MaxUint256);
          await expect(
            retail.connect(user2).depositMultiple([TOKENS.ALT], [amt]),
          ).to.be.revertedWithCustomError(retail, "DepositTooSmall");
          return;
        }
        amt = amt * 2n;
      }
    });
  });

  describe("Getters", () => {
    it("global config", async () => {
      const cfg = await retail.getGlobalConfig();
      expect(cfg.kingContractAddress).to.equal(KING_ADDRESS);
      expect(cfg.depositFeeBpsValue).to.equal(DEPOSIT_FEE_BPS);
      expect(cfg.unwrapFeeBpsValue).to.equal(UNWRAP_FEE_BPS);
      expect(cfg.epochDurationValue).to.equal(EPOCH_DURATION_S);
      expect(cfg.nextEpochTimestampValue).to.not.equal(0);
      expect(cfg.accruedFeesValue).to.be.equal(0);
    });

    it("limits & previews", async () => {
      const [tokens, limits] = await retail.getTokensAndLimits();
      expect(tokens).to.include(TOKENS.ALT);
      expect(limits[tokens.indexOf(TOKENS.ALT)]).to.equal(LIMITS[TOKENS.ALT]);

      const [net] = await retail.previewDepositMultiple([TOKENS.ALT], [parseEther("0.2")]);
      expect(net).to.be.gt(0);
      const res = await retail.previewUnwrap(parseEther("0.1"));
      expect(res.feeAmount).to.be.gt(0);
      expect(res.kingFeeAmount).to.be.eq(0); //king contract set 0 fees
      expect(res.tokens).to.be.an("array").that.is.not.empty;
      expect(res.amounts).to.be.an("array").that.is.not.empty;
    });

    it("previewDeposit and previewUnwrap - zero and revert branches", async () => {
      await expect(retail.previewDepositMultiple([TOKENS.ALT], [])).to.be.revertedWithCustomError(
        retail,
        "AssetArrayLengthMismatch",
      );

      const res = await retail.previewDepositMultiple([], []);
      expect(res.kingToReceiveNet).to.be.eq(0);
      expect(res.retailFeeAmount).to.be.eq(0);
      expect(res.kingInternalFeeAmount).to.eq(0);

      const res2 = await retail.previewUnwrap(0);
      expect(res2.tokens).to.be.empty;
      expect(res2.amounts).to.be.empty;
      expect(res2.feeAmount).to.be.equal(0);
      expect(res2.kingFeeAmount).to.be.equal(0);
    });

    it("get all info", async () => { 
      const res = await retail.getAllInfo();
      expect(res.kingContractAddress).to.equal(KING_ADDRESS);
      expect(res.depositFeeBpsValue).to.equal(DEPOSIT_FEE_BPS);
      expect(res.unwrapFeeBpsValue).to.equal(UNWRAP_FEE_BPS);
      expect(res.epochDurationValue).to.equal(EPOCH_DURATION_S);
      expect(res.nextEpochTimestampValue).to.be.gt(0); // Check it's initialized
      expect(res.accruedFeesValue).to.equal(0);

      const expectedTokens = Object.values(TOKENS);
      // expect(res.tokens).to.have.deep.members(expectedTokens);

      // Ensure order matches for limits, used, paused, prices
      const tokenMap = new Map(res.tokens.map((t, i) => [t, i]));

      for (const tokenAddr of expectedTokens) {
        const index = tokenMap.get(tokenAddr);
        expect(index).to.not.be.undefined;
        if (index !== undefined) {
          expect(res.limits[index]).to.equal(LIMITS[tokenAddr]);
          expect(res.used[index]).to.equal(0);
          expect(res.pausedStatuses[index]).to.equal(false);
          expect(res.prices[index]).to.be.gt(0); // Price should be fetched
        }
      }
    });
  });

  /*************************************************
   *                OPERATIONS                     *
   *************************************************/
  describe("Operations", () => {
    it("pause / unpause", async () => {
      await retail.connect(admin).pauseDeposits();
      await expect(retail.connect(user3).depositMultiple([TOKENS.ALT], [1])).to.be.revertedWithCustomError(
        retail,
        "EnforcedPause",
      );
      const res = await retail.getDepositableTokens();
      expect(res).to.be.empty;

      await retail.connect(admin).unpauseDeposits();
      const res2 = await retail.getDepositableTokens();
      expect(res2).to.include(TOKENS.ALT);
    });

    it("withdraw fees", async () => {
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [parseEther("0.4")]);
      const accrued = await retail.accruedFees();

      const before = await king.balanceOf(admin.address);
      const tx = await retail.connect(admin).withdrawFees(accrued);
      await expect(tx).to.emit(retail, "FeesWithdrawn").withArgs(admin.address, accrued);
      expect(await king.balanceOf(admin.address)).to.equal(before + accrued);
    });

    it("no fees to withdraw revert", async () => {
      await expect(retail.connect(admin).withdrawFees(1)).to.be.revertedWithCustomError(retail, "NoFeesToWithdraw");
    });

    it("token amount to usd", async () => {
      const amount = parseEther("1");
      const res = await retail.tokenAmountToUsd(TOKENS.EIGEN, amount);
      expect(res).to.be.not.equal(0);

      const res0 = await retail.tokenAmountToUsd(TOKENS.SWELL, 0);
      expect(res0).to.be.eq(0);

      const usdcAmount = parseUnits("1", 6);
      await expect(retail.tokenAmountToUsd(USDC, usdcAmount)).to.be.reverted; //because in king's oracle it's not in token config
    });
  });

  /*************************************************
   *                  SCENARIOS                    *
   *************************************************/
  describe("Scenarios", () => {
    //don't work with full limit, king problem
    it("two whales split SWELL and fill the epoch", async () => {
      const half = parseEther("0.001");
      await retail.setDepositLimits([TOKENS.SWELL], [half * 2n]);

      // send half the limit to the second whale
      await swell.connect(user4).transfer(user1.address, half);
      await swell.connect(user1).approve(retail.target, MaxUint256);

      // simply execute one after another (order doesn’t matter)
      await retail.connect(user4).depositMultiple([TOKENS.SWELL], [half]);

      const [, usedBefore] = await retail.getTokenDepositInfo(TOKENS.SWELL);
      expect(usedBefore).to.equal(half);

      await retail.connect(user1).depositMultiple([TOKENS.SWELL], [half]);

      // further SWELL deposit must revert — limit is full
      await expect(retail.connect(user3).depositMultiple([TOKENS.SWELL], [1])).to.be.revertedWithCustomError(
        retail,
        "DepositLimitExceeded",
      );

      const [, used] = await retail.getTokenDepositInfo(TOKENS.SWELL);
      expect(used).to.equal(half * 2n);
    });

    it("mid-epoch limit slash", async () => {
      const part = LIMITS[TOKENS.ETHFI] / 3n;

      // user deposits one third of the original limit
      await retail.connect(user1).depositMultiple([TOKENS.ETHFI], [part]);

      // admin cuts the limit below the already-used amount
      await retail.connect(admin).setDepositLimits([TOKENS.ETHFI], [part - 1n]);

      // any new deposit must fail
      await expect(retail.connect(user2).depositMultiple([TOKENS.ETHFI], [1])).to.be.revertedWithCustomError(
        retail,
        "DepositLimitExceeded",
      );

      const [limit, used] = await retail.getTokenDepositInfo(TOKENS.ETHFI);
      expect(limit).to.equal(part - 1n);
      expect(used).to.equal(part);
    });

    it("token pause versus global pause", async () => {
      // pause only EIGEN
      await retail.connect(admin).setTokenPause(TOKENS.EIGEN, true);
      await expect(
        retail.connect(user2).depositMultiple([TOKENS.EIGEN], [parseEther("1")]),
      ).to.be.revertedWithCustomError(retail, "TokenPaused");

      // un-pause token, then globally pause everything
      await retail.connect(admin).setTokenPause(TOKENS.EIGEN, false);
      await retail.connect(admin).pauseDeposits();

      await expect(retail.connect(user2).depositMultiple([TOKENS.EIGEN], [1])).to.be.revertedWithCustomError(
        retail,
        "EnforcedPause",
      );

      // un-pause globally and ensure deposit succeeds
      await retail.connect(admin).unpauseDeposits();
      await retail.connect(user2).depositMultiple([TOKENS.EIGEN], [parseEther("0.000000001")]);
    });

    it("multi-epoch rollover", async () => {
      await retail.connect(admin).setEpochDuration(3600, true);
      await time.increase(EPOCH_DURATION_S + 1); //because in update -> block.timestamp >= nextEpochTimestamp

      for (let i = 0; i < 3; i++) {
        await time.increase(3601);
        await retail.connect(user3).depositMultiple([TOKENS.ALT], [parseEther("0.0001")]);

        const [, used] = await retail.getTokenDepositInfo(TOKENS.ALT);
        expect(used).to.equal(parseEther("0.0001"));
      }
    });

    it("fees accrue and can be withdrawn in two steps", async () => {
      const amt = parseEther("0.05");

      // four small deposits across different tokens/users
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [amt]);
      await retail.connect(user1).depositMultiple([TOKENS.ETHFI], [amt]);
      await retail.connect(user2).depositMultiple([TOKENS.EIGEN], [amt]);
      await retail.connect(user4).depositMultiple([TOKENS.SWELL], [amt]);

      const total = await retail.accruedFees();
      const half = total / 2n;

      const balBefore = await king.balanceOf(admin.address);
      await retail.connect(admin).withdrawFees(half);
      expect(await retail.accruedFees()).to.equal(total - half);
      expect(await king.balanceOf(admin.address)).to.equal(balBefore + half);

      // withdraw the rest
      await retail.connect(admin).withdrawFees(MaxUint256);
      expect(await retail.accruedFees()).to.equal(0);
    });

    it("double unwrap should revert on the second call", async () => {
      const dep = parseEther("0.2");
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [dep]);

      const kingAmt = await king.balanceOf(user3.address);
      await king.connect(user3).approve(retail.target, kingAmt);

      // first unwrap succeeds, second one should fail because balance is already zero
      const tx1 = retail.connect(user3).unwrap(kingAmt);
      const tx2 = retail.connect(user3).unwrap(kingAmt);

      await expect(tx1).to.emit(retail, "Unwrapped");
      await expect(tx2).to.be.reverted;
    });

    it("admin renounces DEFAULT_ADMIN_ROLE and loses privileges", async () => {
      await retail.connect(admin).setDepositFeeBps(500);

      // admin voluntarily removes own role
      await retail.connect(admin).renounceRole(await retail.DEFAULT_ADMIN_ROLE(), admin.address);

      // any further privileged call must revert
      await expect(retail.connect(admin).setDepositFeeBps(600)).to.be.reverted;

      // non-privileged user functions still work
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [parseEther("0.0002")]);
    });

    it("contract life-cycle", async () => {
      /* make epochs short for test speed */
      await retail.connect(admin).setEpochDuration(3600, true);
      await time.increase(EPOCH_DURATION_S + 1); // because in update -> block.timestamp >= nextEpochTimestamp

      /* ---------- 1. user1 deposits ETHFI ----------------------------------- */
      const ethfiAmt = parseEther("0.08");
      const u1EthfiBefore = await ethfi.balanceOf(user1);
      await retail.connect(user1).depositMultiple([TOKENS.ETHFI], [ethfiAmt]);
      expect(await ethfi.balanceOf(user1)).to.equal(u1EthfiBefore - ethfiAmt);

      /* ---------- 2. user2 deposits EIGEN ----------------------------------- */
      const eigenAmt = parseEther("0.12");
      const u2EigenBefore = await eigen.balanceOf(user2);
      await retail.connect(user2).depositMultiple([TOKENS.EIGEN], [eigenAmt]);
      expect(await eigen.balanceOf(user2)).to.equal(u2EigenBefore - eigenAmt);

      /* ---------- 3. epoch rollover (auto-reset on first tx after jump) ----- */
      await time.increase(3601);
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [parseEther("0.01")]);
      const [, usedEthfiAfterReset] = await retail.getTokenDepositInfo(TOKENS.ETHFI);
      expect(usedEthfiAfterReset).to.equal(0); // previous usage cleared

      /* ---------- 4. user3 deposits ALT in fresh epoch ---------------------- */
      const altAmt = parseEther("0.05");
      await retail.connect(user3).depositMultiple([TOKENS.ALT], [altAmt]);
      const kingBalAfterDeposit = await king.balanceOf(user3);

      /* ---------- 5. user3 unwraps 60 % of just-minted KING ----------------- */
      const unwrapAmt = (kingBalAfterDeposit * 60n) / 100n; // ~60 %
      await king.connect(user3).approve(retail.target, unwrapAmt);
      const feeBefore = await retail.accruedFees();
      await retail.connect(user3).unwrap(unwrapAmt);
      expect(await retail.accruedFees()).to.be.gt(feeBefore);

      /* ---------- 6. LIMIT shrink + failing SWELL deposit ------------------- */
      const smallLimit = parseEther("0.02");
      await retail.connect(admin).setDepositLimits([TOKENS.SWELL], [smallLimit]);

      // user4 (whale) already approved SWELL earlier
      await expect(
        retail.connect(user4).depositMultiple([TOKENS.SWELL], [smallLimit + 1n]),
      ).to.be.revertedWithCustomError(retail, "DepositLimitExceeded");

      /* ---------- 7. successful multi-deposit SWELL + ETHFI ----------------- */
      // transfer some SWELL to user1 so he now has 2 tokens for multi-deposit
      const halfLimit = smallLimit / 2n;
      await swell.connect(user4).transfer(user1, halfLimit);
      await swell.connect(user1).approve(retail.target, MaxUint256);
      const kingBeforeMD = await king.balanceOf(user1);
      const [netPrev] = await retail.previewDepositMultiple(
        [TOKENS.SWELL, TOKENS.ETHFI],
        [halfLimit, 0n], // second token zero-amount
      );

      await retail.connect(user1).depositMultiple([TOKENS.SWELL, TOKENS.ETHFI], [halfLimit, 1n]);
с
      expect((await king.balanceOf(user1)) - kingBeforeMD).to.equal(netPrev);

      /* ---------- 8. SWELL usage should equal halfLimit --------------------- */
      const [, usedSwell] = await retail.getTokenDepositInfo(TOKENS.SWELL);
      expect(usedSwell).to.equal(halfLimit);

      /* ---------- 9. final fee withdrawal ----------------------------------- */
      const fees = await retail.accruedFees();
      const adminKingBefore = await king.balanceOf(admin);
      await retail.connect(admin).withdrawFees(fees);
      expect(await retail.accruedFees()).to.equal(0);
      expect(await king.balanceOf(admin)).to.equal(adminKingBefore + fees);
    });
  });
});