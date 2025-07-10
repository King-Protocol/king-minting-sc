// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IRetailCore {
    /*//////////////////////////////////////////////////////////////
                           USER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit multiple tokens under fixed per-token limits.
    function depositMultiple(address[] calldata tokens, uint256[] calldata amounts) external;

    /// @notice Unwrap King tokens back to underlying assets.
    function unwrap(uint256 kingAmount) external;

    /*//////////////////////////////////////////////////////////////
                       GOVERNANCE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Set or update epoch duration.
    function setEpochDuration(uint256 _epochDuration, bool resetNow) external;

    /// @notice Configure fixed deposit limits for specified tokens.
    function setDepositLimits(address[] calldata tokens, uint256[] calldata amounts) external;

    /// @notice Pause or unpause a specific token.
    function setTokenPause(address token, bool pausedStatus) external;

    /// @notice Pause all deposits globally.
    function pauseDeposits() external;

    /// @notice Unpause all deposits globally.
    function unpauseDeposits() external;

    /// @notice Update deposit fee.
    function setDepositFeeBps(uint256 _bps) external;

    /// @notice Update unwrap fee.
    function setUnwrapFeeBps(uint256 _bps) external;

    /// @notice Withdraw accrued fees in King tokens.
    function withdrawFees(uint256 amount) external;

    /// @notice Update the price provider contract from King contract.
    function updatePriceProvider() external;

    /*//////////////////////////////////////////////////////////////
                           VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Preview the outcome of depositing multiple tokens without executing it.
    function previewDepositMultiple(
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external view returns (
        uint256 kingToReceiveNet,
        uint256 retailFeeAmount,
        uint256 kingInternalFeeAmount
    );

    /// @notice Preview the outcome of an unwrap without executing it.
    function previewUnwrap(uint256 kingAmount)
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory amounts,
            uint256 feeAmount,
            uint256 kingFeeAmount
        );

    /// @notice Get a list of tokens currently available for deposit.
    function getDepositableTokens() external view returns (address[] memory depositableTokens);

    /// @notice Returns current epoch configuration.
    function getEpochInfo() external view returns (uint256 duration, uint256 nextEpoch);

    /// @notice Get all global configuration parameters of the RetailCore contract.
    function getGlobalConfig()
        external
        view
        returns (
            address kingContractAddress,
            uint256 depositFeeBpsValue,
            uint256 unwrapFeeBpsValue,
            uint256 epochDurationValue,
            uint256 nextEpochTimestampValue,
            uint256 accruedFeesValue
        );

    /// @notice Returns limit and used deposit amount for a specific token.
    function getTokenDepositInfo(address token) external view returns (uint256 limit, uint256 used);

    /// @notice Returns pause status for a specific token.
    function tokenPaused(address token) external view returns (bool paused);

    /// @notice Returns all settings
    function getAllInfo()  external
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
        );
}
