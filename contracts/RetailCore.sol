// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// Interfaces
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IKing } from "./IKing.sol";
import { IRetailCore } from "./IRetailCore.sol";
import { IPriceProvider } from "./IPriceProvider.sol";

// OZ Upgradeable Contracts
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title RetailCore
 * @notice Core retail module: handles deposits, withdrawals, and fixed token limits with epochs.
 */
contract RetailCore is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IRetailCore
{
    using SafeERC20 for IERC20;
    using SafeERC20 for IKing;

    /// CONSTANTS & ROLES
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_FEE_VALUE = 5000;

    /// STATE VARIABLES
    /// @notice Address of the main King contract
    IKing public kingContract;
    /// @notice Deposit fee in basis points (1 BPS = 0.01%).
    uint256 public depositFeeBps;
    /// @notice Unwrap fee in basis points (1 BPS = 0.01%).
    uint256 public unwrapFeeBps;
    /// @notice Address of the price provider contract used for value calculations.
    IPriceProvider public priceProvider;

    /// @notice Accrued fees in KING tokens available for withdrawal
    uint256 public accruedFees;

    /// @notice Epoch duration in seconds
    uint256 public epochDuration;
    /// @notice Timestamp when current epoch ends
    uint256 public nextEpochTimestamp;

    /// @notice Fixed deposit limits per token.
    mapping(address => uint256) public depositLimit;
    /// @notice Amount already deposited per token this epoch.
    mapping(address => uint256) public depositUsed;
    /// @notice Pause status per token.
    mapping(address => bool) public tokenPaused;

    /// EVENTS
    event FeesSet(uint256 depositFeeBps, uint256 unwrapFeeBps);
    event EpochDurationSet(uint256 durationSeconds);
    event EpochReset(uint256 nextEpochTimestamp);
    event DepositLimitSet(address indexed token, uint256 quantity);
    event TokenPauseChanged(address indexed token, bool paused);
    event Deposited(
        address indexed user,
        address[] indexed tokens,
        uint256[] tokenAmounts,
        uint256 kingReceived,
        uint256 feeAmount
    );
    event Unwrapped(address indexed user, uint256 kingAmountBurned, uint256 feeAmount);
    event FeesWithdrawn(address indexed governor, uint256 amount);
    event PriceProviderUpdated(address indexed newProvider);

    /// ERRORS
    error ZeroAddress();
    error InvalidAmount();
    error AssetArrayLengthMismatch();
    error EmptyDeposit();
    error DepositTooSmall();
    error TokenPaused();
    error TokenNotWhitelisted();
    error DepositLimitExceeded();
    error NoFeesToWithdraw();
    error AlreadyInThisState();
    error InvalidEpochDuration();
    error DepositFeeTooBig();
    error UnwrapFeeTooBig();
    error KingPreviewDepositFailed();
    error KingPreviewRedeemFailed();
    error NetKingAmountZero();

    /// MODIFIERS
    modifier onlyWhitelistedToken(address token) {
        if (!kingContract.isTokenWhitelisted(token)) revert TokenNotWhitelisted();
        _;
    }

    /// CONSTRUCTOR
    constructor() {
        _disableInitializers();
    }

    /// INITIALIZER
    /**
     * @notice Initialize contract parameters.
     * @param _kingContract Address of the King contract.
     * @param _depositFeeBps Initial deposit fee in BPS.
     * @param _unwrapFeeBps Initial unwrap fee in BPS.
     * @param _epochDuration Epoch duration in seconds (0 to use default of 7 days).
     */
    function initialize(
        address _kingContract,
        uint256 _depositFeeBps,
        uint256 _unwrapFeeBps,
        uint256 _epochDuration
    ) public initializer {
        if (_kingContract == address(0)) revert ZeroAddress();
        kingContract = IKing(_kingContract);

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        updatePriceProvider();
        setEpochDuration(_epochDuration, false);
        nextEpochTimestamp = block.timestamp + epochDuration;

        setDepositFeeBps(_depositFeeBps);
        setUnwrapFeeBps(_unwrapFeeBps);
    }

    /// USER-FACING FUNCTIONS
    /**
     * @notice Deposit multiple tokens under fixed per-token limits.
     * @param tokens Array of ERC20 token addresses to deposit.
     * @param amounts Array of token amounts corresponding to each address.
     */
    function depositMultiple(
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external nonReentrant whenNotPaused {
        uint256 tokenCount = tokens.length;
        if (tokenCount != amounts.length) revert AssetArrayLengthMismatch();
        if (tokenCount == 0) revert EmptyDeposit();

        _updateEpochIfNeeded();

        for (uint256 i = 0; i < tokenCount; i++) {
            address tokenAddress = tokens[i];
            uint256 amountToDeposit = amounts[i];
            if (amountToDeposit == 0) revert InvalidAmount();

            if (tokenPaused[tokenAddress]) revert TokenPaused();
            if (!kingContract.isTokenWhitelisted(tokenAddress)) revert TokenNotWhitelisted();

            uint256 allowedLimit = depositLimit[tokenAddress];
            if (allowedLimit == 0 || depositUsed[tokenAddress] + amountToDeposit > allowedLimit)
                revert DepositLimitExceeded();
            depositUsed[tokenAddress] += amountToDeposit;

            IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amounts[i]);
            IERC20(tokenAddress).forceApprove(address(kingContract), amounts[i]);
        }

        uint256 balanceBefore = kingContract.balanceOf(address(this));
        kingContract.deposit(tokens, amounts, address(this));
        uint256 balanceAfter = kingContract.balanceOf(address(this));
        uint256 totalMintedKing = balanceAfter - balanceBefore;

        // Calculate retail fee
        uint256 feeAmount = (totalMintedKing * depositFeeBps) / BPS_DENOMINATOR;
        uint256 netKingAmount = totalMintedKing - feeAmount;
        accruedFees += feeAmount;

        if (netKingAmount == 0) revert DepositTooSmall();

        kingContract.safeTransfer(msg.sender, netKingAmount);
        emit Deposited(msg.sender, tokens, amounts, netKingAmount, feeAmount);
    }

    /**
     * @notice Unwrap King tokens back to underlying assets.
     * @param kingAmount Amount of King tokens to redeem.
     */
    function unwrap(uint256 kingAmount) external nonReentrant {
        if (kingAmount == 0) revert InvalidAmount();

        // Transfer KING tokens from user to this contract
        kingContract.safeTransferFrom(msg.sender, address(this), kingAmount);

        // Calculate retail unwrap fee
        uint256 feeAmount = (kingAmount * unwrapFeeBps) / BPS_DENOMINATOR;
        uint256 netKingAmount = kingAmount - feeAmount; // Amount to actually redeem after fee

        // Accrue the fee (even if netKingAmount is 0)
        if (feeAmount > 0) accruedFees += feeAmount;

        // Get underlying asset balances *before* redemption (to calculate received amounts later)
        // Note: This reads state from King, potentially involving multiple tokens.
        (address[] memory allTokens, uint256[] memory amountsBefore) = kingContract.totalAssets();

        // Redeem the net amount via King contract if > 0
        if (netKingAmount == 0) revert NetKingAmountZero();
        kingContract.redeem(netKingAmount);

        // Get underlying asset balances after redemption
        (, uint256[] memory amountsAfter) = kingContract.totalAssets();

        if (allTokens.length != amountsBefore.length || allTokens.length != amountsAfter.length)
            revert AssetArrayLengthMismatch();

        // Distribute received underlying assets to the user
        for (uint256 i = 0; i < allTokens.length; i++) {
            // Check if this contract's balance of the token decreased (meaning it was received from redemption)
            if (amountsBefore[i] > amountsAfter[i]) {
                uint256 receivedAmount = amountsBefore[i] - amountsAfter[i];
                if (receivedAmount > 0) {
                    IERC20(allTokens[i]).safeTransfer(msg.sender, receivedAmount); // Send asset to user
                }
            }
        }

        emit Unwrapped(msg.sender, kingAmount, feeAmount);
    }

    /// GOVERNANCE FUNCTIONS
    /**
     * @notice Set or update epoch duration.
     * @param _epochDuration New epoch duration in seconds.
     * @param resetNow If true, resets the current epoch immediately.
     */
    function setEpochDuration(uint256 _epochDuration, bool resetNow) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_epochDuration < 1 hours || _epochDuration > 30 days) revert InvalidEpochDuration();
        epochDuration = _epochDuration;
        if (resetNow) _resetEpoch();
        emit EpochDurationSet(epochDuration);
    }

    /**
     * @notice Configure fixed deposit limits for specified tokens.
     * @param tokens Addresses of tokens to update.
     * @param amounts Corresponding maximum deposit amounts per epoch.
     */
    function setDepositLimits(
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 count = tokens.length;
        if (count != amounts.length) revert AssetArrayLengthMismatch();
        for (uint256 i = 0; i < count; i++) {
            depositLimit[tokens[i]] = amounts[i];
            emit DepositLimitSet(tokens[i], amounts[i]);
        }
    }

    /**
     * @notice Pause or unpause a specific token.
     * @param token Token address.
     * @param pausedStatus Pause status.
     */
    function setTokenPause(
        address token,
        bool pausedStatus
    ) external onlyWhitelistedToken(token) onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tokenPaused[token] == pausedStatus) revert AlreadyInThisState();
        tokenPaused[token] = pausedStatus;
        emit TokenPauseChanged(token, pausedStatus);
    }

    /**
     * @notice Pause all deposits globally.
     */
    function pauseDeposits() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause all deposits globally.
     */
    function unpauseDeposits() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Update deposit fee.
     * @param _bps New deposit fee in BPS.
     */
    function setDepositFeeBps(uint256 _bps) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_bps > MAX_FEE_VALUE) revert DepositFeeTooBig();
        depositFeeBps = _bps;
        emit FeesSet(_bps, unwrapFeeBps);
    }

    /**
     * @notice Update unwrap fee.
     * @param _bps New unwrap fee in BPS.
     */
    function setUnwrapFeeBps(uint256 _bps) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_bps > MAX_FEE_VALUE) revert UnwrapFeeTooBig();
        unwrapFeeBps = _bps;
        emit FeesSet(depositFeeBps, _bps);
    }

    /**
     * @notice Withdraw accrued fees in King tokens.
     * @param amount Amount to withdraw.
     */
    function withdrawFees(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 availableFees = accruedFees;
        uint256 withdrawAmount = amount > availableFees ? availableFees : amount;
        if (withdrawAmount == 0) revert NoFeesToWithdraw();
        accruedFees -= withdrawAmount;
        kingContract.safeTransfer(msg.sender, withdrawAmount);
        emit FeesWithdrawn(msg.sender, withdrawAmount);
    }

    /**
     * @notice Manually reset the epoch and clear usage.
     */
    function resetEpoch() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _resetEpoch();
    }

     /**
     * @notice Synchronizes the `priceProvider` address with the one currently set in the `kingContract`.
     * @dev Useful if the King contract updates its price provider. Requires admin role.
     */
    function updatePriceProvider() public onlyRole(DEFAULT_ADMIN_ROLE) {
        address newProvider = kingContract.priceProvider();
        if (address(priceProvider) == newProvider) revert AlreadyInThisState();
        priceProvider = IPriceProvider(newProvider);
        emit PriceProviderUpdated(newProvider); 
    }

    /// INTERNAL HELPERS
    function _updateEpochIfNeeded() internal {
        if (epochDuration > 0 && block.timestamp >= nextEpochTimestamp) {
            _resetEpoch();
        }
    }

    function _resetEpoch() internal {
        // The helper function determines the correct timestamp for the end of the
        // current or next epoch based on the fixed schedule.
        uint256 newNextTimestamp = _getCurrentEffectiveNextEpochTimestamp();
        // Assign the calculated timestamp to the state variable.
        // If the epoch hasn't actually ended (e.g., manual reset before expiry),
        // the helper function returns the current nextEpochTimestamp,
        // so the state variable effectively remains unchanged regarding the timestamp.
        // If the epoch has ended, the helper returns the correctly calculated future timestamp.
        nextEpochTimestamp = newNextTimestamp;

        address[] memory allTokensList = kingContract.allTokens();
        uint256 totalTokens = allTokensList.length;
        for (uint256 i = 0; i < totalTokens; i++) {
            delete depositUsed[allTokensList[i]];
        }
        emit EpochReset(newNextTimestamp);
    }

    /**
     * @dev Calculates the effective timestamp for the end of the current epoch,
     *      accounting for potentially missed epochs.
     * @return The timestamp when the current epoch actually ends.
     */
    function _getCurrentEffectiveNextEpochTimestamp() internal view returns (uint256) {
        // Read current state
        uint256 storedNextTimestamp = nextEpochTimestamp;
        uint256 duration = epochDuration;
        
        // Check if the stored timestamp has passed
        if (block.timestamp >= storedNextTimestamp) {
            // Calculate how many full epochs have passed since the stored time
            uint256 elapsed = block.timestamp - storedNextTimestamp;
            // Safe division because duration > 0 checked above
            uint256 epochsPassed = elapsed / duration;
            // Calculate the end time of the *current* epoch
            return storedNextTimestamp + (epochsPassed + 1) * duration;
        } else {
            // We are still within the originally scheduled epoch
            return storedNextTimestamp;
        }
    }



     /**
     * @dev Converts a token amount to its approximate USD value.
     * @param token The token address.
     * @param amount The token amount (in its smallest unit).
     * @return usdValue The approximate value in USD (18 decimals). Returns 0 on price error.
     */
    function _tokenAmountToUsd(address token, uint256 amount) internal view returns (uint256 usdValue) {
        if (amount == 0) return 0;
        // Get the price of the token in ETH
        uint256 tokenPriceInEth = priceProvider.getPriceInEth(token);
        if (tokenPriceInEth == 0) return 0;

        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint256 divisor = 10 ** tokenDecimals;
        // Divisor practically never 0 for valid decimals, but check for safety.
        if (divisor == 0) return 0;

        // Calculate the ETH value of the token amount: (amount * tokenPriceInEth) / 10**tokenDecimals
        // Safe division: divisor > 0 checked above.
        uint256 ethValue = (amount * tokenPriceInEth) / divisor;

        return _ethToUsd(ethValue);
    }

     /**
     * @dev Converts an ETH value to USD value using the contract's price provider.
     * @param ethValue The value in ETH (18 decimals).
     * @return usdValue The value in USD (18 decimals). Returns 0 if price is 0 or on error.
     */
    function _ethToUsd(uint256 ethValue) internal view returns (uint256 usdValue) {
        if (ethValue == 0) return 0;
        // Fetch ETH/USD price from the provider
        (uint256 price, uint8 decimals) = priceProvider.getEthUsdPrice();
        if (price == 0) return 0;

        // Calculate denominator based on price decimals
        uint256 denominator = 10 ** decimals;
        if (denominator == 0) return 0;

        // Calculate USD value: (ethValue * price) / 10**decimals
        // Assuming price is USD per 1 ETH, and ethValue has 18 decimals. Result will have 18 decimals.
        return (ethValue * price) / denominator;
    }


    /// GETTERS
    /**
     * @notice Helper view function to convert a token amount to its approximate USD value using the contract's price provider.
     * @param token The address of the token.
     * @param amount The amount of the token (in its smallest unit).
     * @return usdValue The approximate value in USD (18 decimals). Returns 0 on price error.
     */
    function tokenAmountToUsd(address token, uint256 amount) public view returns (uint256 usdValue) {
        return _tokenAmountToUsd(token, amount);
    }

    /**
     * @notice Returns limit and used deposit amount for a specific token.
     * @param token Token address to query.
     * @return limit Maximum allowed this epoch.
     * @return used Amount already deposited this epoch.
     */
    function getTokenDepositInfo(address token) external view returns (uint256 limit, uint256 used) {
        limit = depositLimit[token];
        used = depositUsed[token];
    }

    /**
     * @notice Returns pause status for a specific token.
     * @param token Token address to query.
     * @return pausedStatus True if token deposits are paused.
     */
    function isTokenPaused(address token) external view returns (bool pausedStatus) {
        pausedStatus = tokenPaused[token];
    }

    /**
     * @notice Returns current epoch configuration.
     * @return duration Epoch duration in seconds.
     * @return nextEpoch Timestamp when the next epoch ends.
     */
    function getEpochInfo() external view returns (uint256 duration, uint256 nextEpoch) {
        duration = epochDuration;
        nextEpoch = nextEpochTimestamp;
    }

    /**
     * @notice Preview the outcome of depositing multiple tokens without executing it.
     * @dev Calculates the expected KING tokens to be received net of fees, the retail fee,
     *      and any internal King fee, based on the current state and fees.
     * @param tokens Array of addresses of the ERC20 tokens to simulate depositing.
     * @param amounts Array of amounts of the tokens to simulate depositing. Must match `tokens` array length.
     * @return kingToReceiveNet Estimated amount of KING tokens the user would receive after the retail fee.
     * @return retailFeeAmount Estimated deposit fee charged by RetailCore (in KING tokens).
     * @return kingInternalFeeAmount Estimated fee/adjustment charged internally by the King contract (in KING tokens), if reported by its preview.
     */
    function previewDepositMultiple(
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external view returns (uint256 kingToReceiveNet, uint256 retailFeeAmount, uint256 kingInternalFeeAmount) {
        uint256 numDeposits = tokens.length;
        if (numDeposits != amounts.length) revert AssetArrayLengthMismatch();

        if (numDeposits == 0) return (0, 0, 0);

        uint256 kingMintedGross; // Total KING amount before deducting the RetailCore fee

        // Use try/catch for safe external call to King's preview function
        try kingContract.previewDeposit(tokens, amounts) returns (
            uint256 grossMint, // Temporary variable for King's result
            uint256 kingFee // Temporary variable for King's fee
        ) {
            kingMintedGross = grossMint;
            kingInternalFeeAmount = kingFee; // Store King's internal fee
        } catch Error(string memory reason) {
            revert(reason);
        } catch {
            revert KingPreviewDepositFailed();
        }

        // If King's preview returned 0, the deposit is too small or invalid
        // Return 0 net KING, 0 retail fee, but potentially a non-zero King fee
        if (kingMintedGross == 0) {
            return (0, 0, kingInternalFeeAmount);
        }

        // King's preview already returns the amount NET of its internal fee,
        // so we calculate our retail fee directly on that value.
        retailFeeAmount = (kingMintedGross * depositFeeBps) / BPS_DENOMINATOR;
        kingToReceiveNet = kingMintedGross - retailFeeAmount;

        return (kingToReceiveNet, retailFeeAmount, kingInternalFeeAmount);
    }

    /**
     * @notice Preview the outcome of an unwrap without executing it.
     * @dev Calculates the expected underlying assets to be received and both retail and King fees.
     * @param kingAmount The amount of KING tokens to simulate unwrapping.
     * @return tokens Array of underlying token addresses expected.
     * @return amounts Array of corresponding token amounts expected.
     * @return feeAmount Estimated retail unwrap fee in KING tokens.
     * @return kingFeeAmount Estimated fee charged by the King contract during redemption (if any), in KING-equivalent value or units as defined by King.
     */
    function previewUnwrap(
        uint256 kingAmount
    )
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256 feeAmount, uint256 kingFeeAmount)
    {
        if (kingAmount == 0) return (new address[](0), new uint256[](0), 0, 0);

        // Calculate the retail fee first
        feeAmount = (kingAmount * unwrapFeeBps) / BPS_DENOMINATOR;

        // Calculate the net amount of KING to be redeemed after the retail fee
        uint256 netKingAmount;
        netKingAmount = kingAmount - feeAmount;

        // Call the King contract's preview function with the net amount
        // Keep try/catch for the external call with specific error handling
        try kingContract.previewRedeem(netKingAmount) returns (
            address[] memory assetsFromKing,
            uint256[] memory amountsFromKing,
            uint256 feeFromKing // King's internal fee
        ) {
            tokens = assetsFromKing;
            amounts = amountsFromKing;
            kingFeeAmount = feeFromKing; // Capture the fee reported by King
        } catch Error(string memory reason) {
            // Propagate specific error reason from King if available
            revert(reason);
        } catch {
            // Fallback error if King reverts without a reason string
            revert KingPreviewRedeemFailed();
        }
    }

    /**
     * @notice Get tokens and limits
     * @dev Returns the list of tokens, their corresponding deposit limits and used amounts.
     * @return tokens Array of token addresses.
     * @return limits Array of corresponding deposit limits.
     * @return used Array of corresponding used amounts.
     * @return pausedStatuses Array of corresponding pause statuses.
     */
    function getTokensAndLimits()
        public
        view
        returns (address[] memory tokens, uint256[] memory limits, uint256[] memory used, bool[] memory pausedStatuses)
    {
        address[] memory allTokensList = kingContract.allTokens();
        uint256 totalTokens = allTokensList.length;
        tokens = new address[](totalTokens);
        limits = new uint256[](totalTokens);
        used = new uint256[](totalTokens);
        pausedStatuses = new bool[](totalTokens);

        for (uint256 i = 0; i < totalTokens; i++) {
            tokens[i] = allTokensList[i];
            limits[i] = depositLimit[allTokensList[i]];
            used[i] = depositUsed[allTokensList[i]];
            pausedStatuses[i] = tokenPaused[allTokensList[i]];
        }
    }

    /**
     * @notice Get a list of tokens currently available for deposit.
     * @dev Filters tokens registered in King, checking for global pause, King whitelist status, and retail token pause status.
     * WARNING: Iterates over ALL tokens registered in King. Gas intensive.
     * @return depositableTokens Array of token addresses that are currently depositable.
     */
    function getDepositableTokens() external view returns (address[] memory depositableTokens) {
        if (paused()) return new address[](0);

        address[] memory allTokensList = kingContract.allTokens();
        uint256 totalTokens = allTokensList.length;
        address[] memory tempDepositable = new address[](totalTokens);
        uint256 depositableCount = 0;

        for (uint256 i = 0; i < totalTokens; i++) {
            address tokenAddress = allTokensList[i];
            if (kingContract.isTokenWhitelisted(tokenAddress) && !tokenPaused[tokenAddress]) {
                tempDepositable[depositableCount] = tokenAddress;
                depositableCount++;
            }
        }
        depositableTokens = new address[](depositableCount);
        for (uint256 i = 0; i < depositableCount; i++) {
            depositableTokens[i] = tempDepositable[i];
        }
    }

    /**
     * @notice Get all global configuration parameters of the RetailCore contract.
     * @dev Useful for monitoring to fetch contract state in one call.
     * @return kingContractAddress Address of the associated King contract.
     * @return depositFeeBpsValue Current deposit fee in basis points.
     * @return unwrapFeeBpsValue Current unwrap fee in basis points.
     * @return epochDurationValue Configured epoch duration in seconds.
     * @return nextEpochTimestampValue Timestamp of the next epoch reset.
     * @return accruedFeesValue Current amount of accrued fees in KING tokens.
     */
    function getGlobalConfig()
        public
        view
        returns (
            address kingContractAddress,
            uint256 depositFeeBpsValue,
            uint256 unwrapFeeBpsValue,
            uint256 epochDurationValue,
            uint256 nextEpochTimestampValue,
            uint256 accruedFeesValue
        )
    {
        kingContractAddress = address(kingContract);
        depositFeeBpsValue = depositFeeBps;
        unwrapFeeBpsValue = unwrapFeeBps;
        epochDurationValue = epochDuration;
        accruedFeesValue = accruedFees;
        nextEpochTimestampValue = _getCurrentEffectiveNextEpochTimestamp();
    }
    /**
     * @notice Get all global configuration parameters and token limits.
     * @return kingContractAddress Address of the associated King contract.
     * @return depositFeeBpsValue Current deposit fee in basis points.
     * @return unwrapFeeBpsValue Current unwrap fee in basis points.
     * @return epochDurationValue Configured epoch duration in seconds.
     * @return nextEpochTimestampValue Timestamp of the next epoch reset.
     * @return accruedFeesValue Current amount of accrued fees in KING tokens.
     * @return tokens Array of token addresses.
     * @return limits Array of corresponding deposit limits.
     * @return used Array of corresponding used amounts.
     * @return pausedStatuses Array of corresponding pause statuses.
     * @return prices Array of token prices in USD per 1 token.
     */
    function getAllInfo()
        external
        view
        returns (
            address kingContractAddress,
            uint256 depositFeeBpsValue,
            uint256 unwrapFeeBpsValue,
            uint256 epochDurationValue,
            uint256 nextEpochTimestampValue,
            uint256 accruedFeesValue,
            address[] memory tokens, 
            uint256[] memory limits,
            uint256[] memory used,
            bool[] memory pausedStatuses,
            uint256[] memory prices
        )
    {
        (kingContractAddress, depositFeeBpsValue, unwrapFeeBpsValue, epochDurationValue, nextEpochTimestampValue, accruedFeesValue) = getGlobalConfig();
        (tokens, limits, used, pausedStatuses) = getTokensAndLimits();
        prices = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            prices[i] = tokenAmountToUsd(tokens[i], 10**IERC20Metadata(tokens[i]).decimals());
        }
    }
}
