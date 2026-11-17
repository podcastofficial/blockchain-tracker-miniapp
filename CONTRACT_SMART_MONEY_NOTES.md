# Contract → Smart Wallet Discovery

## What this adds
- Authenticated `GET /api/contract/intelligence?network=ethereum&address=0x...` endpoint.
- Checks that the target address has deployed code on the selected EVM network.
- Reads the latest 100 top-level transactions for the contract from Etherscan API V2.
- Aggregates successful direct calls by sender and classifies senders with `eth_getCode` as EOA, contract, or unknown.
- Shows EOA candidates in the Wallet Terminal Smart Money Intelligence panel.
- A user can manually choose **Follow** to prefill the existing wallet form with category `Smart Money`; saving remains an explicit user action.

## Configuration
Uses the existing `ETHERSCAN_API_KEY` environment variable already used by EVM PnL. No new secret or database migration is required. Optional `RPC_ETHEREUM` can override the existing public Ethereum RPC.

## Important limitations
- This is direct top-level caller discovery only. Router-mediated calls and internal traces can be missing.
- `eth_getCode` empty code at the latest block is used as an EOA heuristic; smart accounts and counterfactual wallets can complicate classification.
- A contract call is not automatically a buy/sell. This endpoint does not manufacture trade signals or profitability scores.
- PnL is calculated only after the user explicitly saves a discovered address as a wallet and the existing PnL indexer successfully indexes its swap history.
- The endpoint returns the latest 100 indexed top-level transactions; it is not a full historical crawler.
