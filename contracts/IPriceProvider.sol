// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IPriceProvider {
    function getPriceInEth(address token) external view returns (uint256);
    function getEthUsdPrice() external view returns (uint256 price, uint8 decimals);
}