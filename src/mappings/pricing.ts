import { Address, Bytes, BigInt, BigDecimal } from '@graphprotocol/graph-ts';
import { Pool, TokenPrice, Balancer, PoolHistoricalLiquidity, LatestPrice } from '../types/schema';
import { ZERO_BD, PRICING_ASSETS, USD_STABLE_ASSETS, ONE_BD, ZERO_ADDRESS } from './helpers/constants';
import { hasVirtualSupply } from './helpers/pools';
import { createPoolSnapshot, getBalancerSnapshot, getToken, loadPoolToken } from './helpers/misc';

export function isPricingAsset(asset: Address): boolean {
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (PRICING_ASSETS[i] == asset) return true;
  }
  return false;
}

export function getPreferentialPricingAsset(assets: Address[]): Address {
  // Assumes PRICING_ASSETS are sorted by order of preference
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (assets.includes(PRICING_ASSETS[i])) return PRICING_ASSETS[i];
  }
  return ZERO_ADDRESS;
}

export function updatePoolLiquidity(poolId: string, block: BigInt, timestamp: i32): boolean {
  let pool = Pool.load(poolId);
  if (pool == null) return false;

  let tokensList: Bytes[] = pool.tokensList;
  if (tokensList.length < 2) return false;

  let poolValueUSD: BigDecimal = ZERO_BD;

  for (let j: i32 = 0; j < tokensList.length; j++) {
    let tokenAddress: Address = Address.fromString(tokensList[j].toHexString());

    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (!poolToken) continue;

    let poolTokenQuantity: BigDecimal = poolToken.balance;

    let token = getToken(tokenAddress);
    let tokenLatestUSDPrice = token.latestUSDPrice;
    if (!tokenLatestUSDPrice) continue;

    // Exclude virtual supply from pool value
    if (hasVirtualSupply(pool) && pool.address == tokenAddress) {
      continue;
    }

    let poolTokenValue = tokenLatestUSDPrice.times(poolTokenQuantity);
    poolValueUSD = poolValueUSD.plus(poolTokenValue);
  }

  let oldPoolLiquidity: BigDecimal = pool.totalLiquidity;
  let newPoolLiquidity: BigDecimal = poolValueUSD;
  let liquidityChange: BigDecimal = newPoolLiquidity.minus(oldPoolLiquidity);

  // If the pool isn't empty but we have a zero USD value then it's likely that we have a bad pricing asset
  // Don't commit any changes and just report the failure.
  if (poolValueUSD.gt(ZERO_BD) != newPoolLiquidity.gt(ZERO_BD)) {
    return false;
  }

  // Take snapshot of pool state
  let phlId = getPoolHistoricalLiquidityId(poolId, USD_STABLE_ASSETS[0], block);
  let phl = new PoolHistoricalLiquidity(phlId);
  phl.poolId = poolId;
  phl.pricingAsset = USD_STABLE_ASSETS[0];
  phl.block = block;
  phl.poolTotalShares = pool.totalShares;
  phl.poolLiquidity = poolValueUSD;
  phl.poolShareValue = pool.totalShares.gt(ZERO_BD) ? poolValueUSD.div(pool.totalShares) : ZERO_BD;
  phl.save();

  // Update pool stats
  pool.totalLiquidity = newPoolLiquidity;
  pool.save();

  // update BPT price
  updateBptPrice(pool);

  // Create or update pool daily snapshot
  createPoolSnapshot(pool, timestamp);

  // Update global stats
  let vault = Balancer.load('2') as Balancer;
  vault.totalLiquidity = vault.totalLiquidity.plus(liquidityChange);
  vault.save();

  let vaultSnapshot = getBalancerSnapshot(vault.id, timestamp);
  vaultSnapshot.totalLiquidity = vault.totalLiquidity;
  vaultSnapshot.save();

  return true;
}

export function valueInUSD(value: BigDecimal, asset: Address): BigDecimal {
  let usdValue = ZERO_BD;

  if (isUSDStable(asset)) {
    usdValue = value;
  } else {
    // convert to USD
    let token = getToken(asset);

    if (token.latestUSDPrice) {
      const latestUSDPrice = token.latestUSDPrice as BigDecimal;
      usdValue = value.times(latestUSDPrice);
    }
  }

  return usdValue;
}

export function updateBptPrice(pool: Pool): void {
  if (pool.totalShares.equals(ZERO_BD)) return;

  const bptAddress = Address.fromString(pool.address.toHexString());
  let bptToken = getToken(bptAddress);
  bptToken.latestUSDPrice = pool.totalLiquidity.div(pool.totalShares);
  bptToken.save();
}

export function swapValueInUSD(
  tokenInAddress: Address,
  tokenAmountIn: BigDecimal,
  tokenOutAddress: Address,
  tokenAmountOut: BigDecimal
): BigDecimal {
  let swapValueUSD = ZERO_BD;

  if (isUSDStable(tokenOutAddress)) {
    // if one of the tokens is a stable, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
  } else if (isUSDStable(tokenInAddress)) {
    // if one of the tokens is a stable, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
  } else if (isPricingAsset(tokenInAddress) && !isPricingAsset(tokenOutAddress)) {
    // if only one of the tokens is a pricing asset, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
  } else if (isPricingAsset(tokenOutAddress) && !isPricingAsset(tokenInAddress)) {
    // if only one of the tokens is a pricing asset, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
  } else {
    // if none or both tokens are pricing assets, take the average of the known prices
    let tokenInSwapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
    let tokenOutSwapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
    let divisor =
      tokenInSwapValueUSD.gt(ZERO_BD) && tokenOutSwapValueUSD.gt(ZERO_BD) ? BigDecimal.fromString('2') : ONE_BD;
    swapValueUSD = tokenInSwapValueUSD.plus(tokenOutSwapValueUSD).div(divisor);
  }

  return swapValueUSD;
}

export function getLatestPriceId(tokenAddress: Address, pricingAsset: Address): string {
  return tokenAddress.toHexString().concat('-').concat(pricingAsset.toHexString());
}

export function updateLatestPrice(tokenPrice: TokenPrice): void {
  let tokenAddress = Address.fromString(tokenPrice.asset.toHexString());
  let pricingAsset = Address.fromString(tokenPrice.pricingAsset.toHexString());

  let latestPriceId = getLatestPriceId(tokenAddress, pricingAsset);
  let latestPrice = LatestPrice.load(latestPriceId);

  if (latestPrice == null) {
    latestPrice = new LatestPrice(latestPriceId);
    latestPrice.asset = tokenPrice.asset;
    latestPrice.pricingAsset = tokenPrice.pricingAsset;
  }

  latestPrice.block = tokenPrice.block;
  latestPrice.poolId = tokenPrice.poolId;
  latestPrice.price = tokenPrice.price;
  latestPrice.save();

  let token = getToken(tokenAddress);
  const pricingAssetAddress = Address.fromString(tokenPrice.pricingAsset.toHexString());
  const tokenInUSD = valueInUSD(tokenPrice.price, pricingAssetAddress);
  token.latestUSDPrice = tokenInUSD;
  token.latestPrice = latestPrice.id;
  token.save();
}

function getPoolHistoricalLiquidityId(poolId: string, tokenAddress: Address, block: BigInt): string {
  return poolId.concat('-').concat(tokenAddress.toHexString()).concat('-').concat(block.toString());
}

export function isUSDStable(asset: Address): boolean {
  for (let i: i32 = 0; i < USD_STABLE_ASSETS.length; i++) {
    if (USD_STABLE_ASSETS[i] == asset) return true;
  }
  return false;
}
