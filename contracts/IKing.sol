// SPDX-License-Identifier: MIT
import {IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

pragma solidity ^0.8.25;

interface IKing is IERC20 {
    // --- View Functions ---
    // Calculates the ETH value of given token amounts
    function getTokenValuesInEth(
        address[] memory tokens,
        uint256[] memory amounts
    ) external view returns (uint256 totalValueEth);

    // Returns all underlying assets held by the King contract
    function totalAssets()
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts);

    // Returns a list of all tokens ever registered (can be gas intensive)
    function allTokens() external view returns (address[] memory);

    // Checks if a token is currently whitelisted for deposits/operations
    function isTokenWhitelisted(address token) external view returns (bool);

    // Returns the total supply of King tokens
    function totalSupply() external view returns (uint256);

    // Previews the assets received for redeeming a certain amount of King shares
    function previewRedeem(
        uint256 shares
    )
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory amounts,
            uint256 feeAmount
        );

    function previewDeposit(address[] memory tokens, uint256[] memory amounts) external view returns (uint256, uint256);
    function priceProvider() external view returns (address);
    function governor() external view returns (address);

    // --- State Changing Functions ---
    function setDepositors(address[] memory depositors, bool[] memory isDepositor) external;

    // Deposits underlying assets to mint King tokens
    // Ensure the parameters match your actual King contract
    function deposit(
        address[] memory tokens,
        uint256[] memory amounts,
        address receiver
    ) external;

    // Redeems King tokens for underlying assets
    // Ensure the parameters match your actual King contract
    function redeem(uint256 shares) external;
}
