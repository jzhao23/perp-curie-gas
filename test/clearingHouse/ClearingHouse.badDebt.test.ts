import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactInput, closePosition, q2bExactInput, removeOrder } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forwardTimestamp } from "../shared/time"
import { encodePriceSqrt, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse badDebt", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let insuranceFund: InsuranceFund
    let clearingHouseConfig: ClearingHouseConfig
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        fixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange as TestExchange
        insuranceFund = fixture.insuranceFund
        clearingHouseConfig = fixture.clearingHouseConfig
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        mockedBaseAggregator = fixture.mockedBaseAggregator
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("100", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            uniFeeRatio,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        // update config
        await marketRegistry.setFeeRatio(baseToken.address, exFeeRatio)
        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 100000) // 10%

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for alice
        const decimals = await collateral.decimals()
        await collateral.mint(alice.address, parseUnits("100000", decimals))
        await deposit(alice, vault, 100000, collateral)

        // prepare collateral for bob
        await collateral.mint(bob.address, parseUnits("100", decimals))
        await deposit(bob, vault, 100, collateral)

        // alice add liquidity
        await addOrder(fixture, alice, "500", "50000", lowerTick, upperTick, false)
    })

    describe("close/reduce position when bad debt", () => {
        describe("taker has long position and market price becomes lower than index price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob open notional: -800
                // bob position size: 7.866
                await q2bExactInput(fixture, bob, "800", baseToken.address)
                // market price = index price = 103.222
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                // alice short base token that causing bob has bad debt(if he close his position)
                await b2qExactInput(fixture, alice, "5000", baseToken.address)

                // bob's account value is greater than 0 bc it's calculated by index price
                // bob's account value: 100 + 7.866 * 103.222 - 800 = 111.944

                expect(await clearingHouse.getAccountValue(bob.address)).to.be.eq("111974414171876722414")

                // to avoid over maxTickCrossedPerBlock
                await forwardTimestamp(clearingHouse)
            })

            it("cannot close position when user has bad debt", async () => {
                // bob close position
                // exchanged notional: 6.510
                // realized PnL: 6.510 - 800 = -793.490
                // account value: 100 - 800 + 6.510 = -693.49 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")
            })

            it("cannot reduce position when user has bad debt", async () => {
                // bob short 2 ETH to reduce position
                // exchanged notional: 1.655
                // realized PnL: 1.655 - 2/7.866 * 800 = -201.7520684
                // account value: 100 + 5.866 * 103.222 - 800 + 1.65 = -92.850 (bad debt)
                await expect(b2qExactInput(fixture, bob, "2", baseToken.address)).to.be.revertedWith("CH_BD")
            })

            it("cannot reduce when not resulting bad debt but with not enough collateral", async () => {
                // bob short 0.5 ETH to reduce position
                // exchanged notional: 0.4139
                // realized PnL: 0.4139 - 0.5/7.866 * 800 = -50.438
                // account value: 100 + 7.366 * 103.222 - 800 + 0.4139 = 60.75 (no bad debt)
                // free collateral: 100 - 50.438 - (800 - 0.4139 + 50.438) * 10% = -35.440
                await expect(b2qExactInput(fixture, bob, "0.5", baseToken.address)).to.be.revertedWith("CH_NEFCI")
            })

            it("can reduce when not resulting bad debt and has enough collateral", async () => {
                // bob short 0.1 ETH to reduce position
                // exchanged notional: 0.083
                // bob's realized PnL: 0.083 - 0.1/7.866 * 800 = -10.087
                // bob's account value: 100 + 7.766 * 103.222 - 800 + 0.083 = 101.705 (no bad debt)
                // bob's free collateral: 100 - 10.087 - (800 - 0.083 + 10.087) * 10% = 8.9126 > 0
                await expect(b2qExactInput(fixture, bob, "0.1", baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("cannot liquidate bad debt position by non backstop liquidity provider", async () => {
                // sync index price to market price so that bob can be liquidated
                // current index price: 0.829
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")

                // close bob's position by liquidation
                // exchanged notional: 6.510
                // realized PnL: 6.510 - 800 = -793.490
                // account value: 100 - 800 + 6.510 = -693.49 (bad debt)
                await expect(
                    clearingHouse
                        .connect(alice)
                        ["liquidate(address,address,uint256)"](bob.address, baseToken.address, 0),
                ).to.be.revertedWith("CH_BD")
            })

            it("can liquidate bad debt position by backstop liquidity provider", async () => {
                // add alice to backstop liquidity provider
                await clearingHouseConfig.setBackstopLiquidityProvider(alice.address, true)

                // sync index price to market price so that bob can be liquidated
                // current index price: 0.829
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")

                // close bob's position by liquidation
                // exchanged notional: 6.510
                // realized PnL: 6.510 - 800 = -793.490
                // account value: 100 - 800 + 6.510 = -693.49 (bad debt)
                // liquidation fee: 0.162
                await expect(
                    clearingHouse
                        .connect(alice)
                        ["liquidate(address,address,uint256)"](bob.address, baseToken.address, 0),
                ).to.emit(clearingHouse, "PositionLiquidated")

                // now every one close position and withdraw their balances
                await closePosition(fixture, alice)

                // remove alice's liquidity
                const aliceLiquidity = (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity
                await removeOrder(fixture, alice, aliceLiquidity, lowerTick, upperTick, baseToken.address)
                expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                    "0",
                    100,
                )

                // all user's withdrawable amount
                const bobFreeCollateral = await vault.getFreeCollateral(bob.address)
                expect(bobFreeCollateral).to.eq(0)

                // alice's pnl = 784.4035329255
                // account value = 100,784.403532
                // margin requirement = 0, since she has already closed position and withdrawn liquidity
                const aliceFreeCollateral = await vault.getFreeCollateral(alice.address)
                expect(aliceFreeCollateral).to.be.eq(parseUnits("100784.403532", await collateral.decimals()))
                // IF gets (800 + 46247 + 6.51035726807423 + 45500) * 0.0001 = 9.255379 as fees
                const ifBalance = await vault.getFreeCollateral(insuranceFund.address)
                expect(ifBalance).to.be.eq(parseUnits("9.255379", await collateral.decimals()))

                // total free collateral =
                // 100000(alice's deposited collateral) + 100(bob's deposited collateral) + 693.49(bob's bad debt) + 0.162(liquidation fee)
                // = 100793.65
                const totalFreeCollateral = aliceFreeCollateral.add(ifBalance)
                expect(totalFreeCollateral).to.be.eq(parseUnits("100793.658911", await collateral.decimals()))
                // total free collateral > total deposits, meaning that there is bad debt
                expect(totalFreeCollateral).to.be.gt(parseUnits("100100", await collateral.decimals()))
            })

            it("cannot close position with partial close when trader has bad debt", async () => {
                // set max price impact to 0.1% to trigger partial close
                await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 10)

                // partial close bob's position: 7.866 * 25% = 1.88784
                // exchanged notional: 1.629
                // realized PnL: 1.629 - 800 * 0.25 = -198.371
                // account value: 100 + 7.866 * 75% * 103.222 - 800 + 1.629 = -89.413 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")
            })
        })

        describe("taker has long position and index price becomes lower than market price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob position size: 7.866
                await q2bExactInput(fixture, bob, "800", baseToken.address)

                // index price becomes lower than market price, bob has bad debt(calc by index price)
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("10", 6), 0, 0, 0]
                })
            })

            // trader can close position even when his margin ratio is negative as long as he does not incur bad debt
            it("can close position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                await closePosition(fixture, bob)
            })

            // on the contrary, the trader might not be able to reduce position because
            // the remaining position might still incur bad debt due to the bad index price
            it("cannot reduce position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                // bob short 1 ETH to reduce position
                // exchanged notional: 103.013
                // realized PnL: 103.013 - 1/7.866 * 800 = 1.20991652
                // account value: 100 + 6.866 * 10 - 800 + 103.013 = -528.327 (bad debt)
                await expect(b2qExactInput(fixture, bob, "1", baseToken.address)).to.be.revertedWith("CH_BD")
            })
        })
    })
})
