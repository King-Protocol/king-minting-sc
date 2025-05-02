**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [incorrect-equality](#incorrect-equality) (1 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (1 results) (Medium)
 - [unused-return](#unused-return) (1 results) (Medium)
 - [calls-loop](#calls-loop) (6 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (1 results) (Low)
## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-0
[RetailCore.depositMultiple(address[],uint256[])](contracts/RetailCore.sol#L142-L183) uses a dangerous strict equality:
	- [netKingAmount == 0](contracts/RetailCore.sol#L179)

contracts/RetailCore.sol#L142-L183


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-1
[RetailCore.previewDepositMultiple(address[],uint256[]).kingMintedGross](contracts/RetailCore.sol#L515) is a local variable never initialized

contracts/RetailCore.sol#L515


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-2
[RetailCore.unwrap(uint256)](contracts/RetailCore.sol#L189-L230) ignores return value by [(None,amountsAfter) = kingContract.totalAssets()](contracts/RetailCore.sol#L213)

contracts/RetailCore.sol#L189-L230


## calls-loop
Impact: Low
Confidence: Medium
 - [ ] ID-3
[RetailCore.getAllInfo()](contracts/RetailCore.sol#L686-L709) has external calls inside a loop: [prices[i] = tokenAmountToUsd(tokens[i],10 ** IERC20Metadata(tokens[i]).decimals())](contracts/RetailCore.sol#L707)

contracts/RetailCore.sol#L686-L709


 - [ ] ID-4
[RetailCore.getDepositableTokens()](contracts/RetailCore.sol#L622-L641) has external calls inside a loop: [kingContract.isTokenWhitelisted(tokenAddress) && ! tokenPaused[tokenAddress]](contracts/RetailCore.sol#L632)

contracts/RetailCore.sol#L622-L641


 - [ ] ID-5
[RetailCore._ethToUsd(uint256)](contracts/RetailCore.sol#L439-L452) has external calls inside a loop: [(price,decimals) = priceProvider.getEthUsdPrice()](contracts/RetailCore.sol#L442)

contracts/RetailCore.sol#L439-L452


 - [ ] ID-6
[RetailCore._tokenAmountToUsd(address,uint256)](contracts/RetailCore.sol#L416-L432) has external calls inside a loop: [tokenPriceInEth = priceProvider.getPriceInEth(token)](contracts/RetailCore.sol#L419)

contracts/RetailCore.sol#L416-L432


 - [ ] ID-7
[RetailCore._tokenAmountToUsd(address,uint256)](contracts/RetailCore.sol#L416-L432) has external calls inside a loop: [tokenDecimals = IERC20Metadata(token).decimals()](contracts/RetailCore.sol#L422)

contracts/RetailCore.sol#L416-L432


 - [ ] ID-8
[RetailCore.depositMultiple(address[],uint256[])](contracts/RetailCore.sol#L142-L183) has external calls inside a loop: [! kingContract.isTokenWhitelisted(tokenAddress)](contracts/RetailCore.sol#L158)

contracts/RetailCore.sol#L142-L183


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-9
Reentrancy in [RetailCore.depositMultiple(address[],uint256[])](contracts/RetailCore.sol#L142-L183):
	External calls:
	- [kingContract.deposit(tokens,amounts,address(this))](contracts/RetailCore.sol#L170)
	State variables written after the call(s):
	- [accruedFees += feeAmount](contracts/RetailCore.sol#L177)

contracts/RetailCore.sol#L142-L183


