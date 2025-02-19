# Chai Bugs

## Chai/Waffle doesn't handle "one contract emits multiple events" correctly

For instance:

```ts
await expect(clearingHouse.openPosition())
    .to.emit(exchange, "FundingPaymentSettled").withArgs(xxx) -> THIS CHECK WILL BE IGNORED
    .to.emit(exchange, "FundingUpdated").withArgs(xxx)
```

We must use the following way to check emitting events from the same contract:

```ts
const tx = await clearingHouse.openPosition()
await expect(tx)
    .to.emit(exchange, "FundingPaymentSettled")
    .withArgs(xxx)
await expect(tx)
    .to.emit(exchange, "FundingUpdated")
    .withArgs(xxx)
```

## Always put `.not` in the end of the chained operations

Once we call `.not`, it will negate all assertions that follow in the chain.

For instance, to make sure it **DOES NOT** emit `PositionChanged`, and **DOES** emit `LiquidityChanged`, we should:

```ts
// DO
await expect(clearingHouse.addLiquidity())
    .to.emit(contract2, "LiquidityChanged")
    .not.to.emit(contract1, "PositionChanged")

// DON'T
await expect(clearingHouse.addLiquidity())
    .not.to.emit(contract1, "PositionChanged")
    .to.emit(contract2, "LiquidityChanged")
```

## `revertedWith()` is not exact match

If your revert msg is `AA_BB`, it passes when `revertedWith("AA")`.
