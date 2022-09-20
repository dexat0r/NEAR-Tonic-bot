import * as near from "near-api-js";
import { FinalExecutionOutcome } from "near-api-js/lib/providers";
import * as dotenv from "dotenv";
import { Market, Tonic } from "@tonic-foundation/tonic";
import { getNearConfig } from "@tonic-foundation/config";
import chalk from "chalk";

dotenv.config({
    path: `./${
        process.env.MODE === "development" ? "development" : "production"
    }.env`,
});

const network = process.env.MODE === "development" ? "testnet" : "mainnet";

const getGasUsage = (o: FinalExecutionOutcome) => {
    const receiptGas = o.transaction_outcome.outcome.gas_burnt;
    const actionGas = o.receipts_outcome.reduce(
        (acc, x) => acc + x.outcome.gas_burnt,
        0
    );
    return `${((receiptGas + actionGas) / Math.pow(10, 12)).toFixed(2)} TGas`;
};

async function monitorOrder(
    tonic: Tonic,
    marketId: string,
    i = 5000
): Promise<void> {
    log(`Waiting until order succeed...`);
    await new Promise<void>((resolve) => {
        let timeStart = Date.now();
        const interval = setInterval(async () => {
            const orders = await tonic.getOpenOrders(marketId);
            if (!orders.length) {
                clearInterval(interval);
                log(`Time passed: ${(Date.now() - timeStart) / 1000} seconds`);
                resolve();
            }
        }, i);
    });
}

async function getTokenBalance(
    tonic: Tonic,
    tokenId: string,
    decimals: number
): Promise<number> {
    const balances = await tonic.getBalances();
    return balances[tokenId] / Math.pow(10, decimals);
}

function log(msg: any, ...args: unknown[]) {
    console.log(
        `${chalk.green(new Date().toLocaleTimeString())}: ${chalk.blue(
            msg
        )} ${args}`
    );
}

async function main(): Promise<void> {
    console.clear();
    log(`Starting bot....`);
    const { keyStores, KeyPair, connect } = near;

    const ks = new keyStores.InMemoryKeyStore();
    const kpair = KeyPair.fromString(process.env.PK!);
    ks.setKey(network, process.env.ACCOUNT_ID!, kpair);

    log(`Key was succesfuly added!`);

    const config: near.ConnectConfig = {
        ...getNearConfig(network),
        keyStore: ks,
    };
    const provider = await connect(config);

    log(`Connected to NEAR!`);

    const account = await provider.account(process.env.ACCOUNT_ID!);
    const tonic = new Tonic(account, process.env.CONTRACT_ID!);

    const marketId = process.env.MARKET_ID!;
    const market = await tonic.getMarket(marketId);

    const orders = await tonic.getOpenOrders(marketId);

    if (orders.length) {
        log(`Closing previous orders...`);
        await tonic.cancelAllOrders(marketId);
    }

    log(`Starting work process!`);

    while (true) {
        const amountBuy = await getTokenBalance(tonic, market.quoteTokenId, market.quoteDecimals);
        if (amountBuy > 0) {
            log(
                `Creating Buy order with amount ${amountBuy} ${
                    market.quoteTokenId.split(".")[0]
                }...`
            );

            try {
                log("Sending transaction...");
                const { executionOutcome: tx, response: _ } =
                    await market.placeOrder({
                        quantity: amountBuy,
                        side: "Buy",
                        orderType: "Limit",
                        limitPrice: Number(process.env.LIMIT || 0.9999),
                    });
                log(`Gas usage: ${getGasUsage(tx)}`);
            } catch (e) {
                log("Order failed", e);
                continue;
            }

            await monitorOrder(tonic, marketId);
        }

        const amountSell = await getTokenBalance(
            tonic,
            market.baseTokenId,
            market.baseDecimals
        );

        log(
            `Creating Sell order with amount ${amountSell} ${
                market.quoteTokenId.split(".")[0]
            }...`
        );
        try {
            log("Sending transaction...");
            const { executionOutcome: tx, response: _ } =
                await market.placeOrder({
                    quantity: amountSell,
                    side: "Sell",
                    orderType: "Market",
                });
            log(`Gas usage: ${getGasUsage(tx)}`);
        } catch (error) {
            log("Order failed", error);
        }

        await monitorOrder(tonic, marketId);
        log(
            `Cycle ends! Received: ${
                (await getTokenBalance(tonic, market.quoteTokenId, market.quoteDecimals)) -
                amountBuy
            }`
        );
    }
}

main();
