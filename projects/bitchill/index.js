const handlers = [
  {
    handler: '0xb60024d0030d7876f02BB766E18F0664e81B0856',
    lendingToken: '0x544Eb90e766B405134b3B3F62b6b4C23Fcd5fDa2', // kDOC (Tropykus)
    stablecoin: '0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db', // DOC
    protocol: 'tropykus',
  },
  {
    handler: '0xA1A752784d4d43778ED23771777B18AE9cb66461',
    lendingToken: '0xd8D25f03EBbA94E15Df2eD4d6D38276B595593c1', // iSUSD (Sovryn iToken)
    protocol: 'sovryn',
  },
  {
    handler: '0xAfcD7A6F5165F09b049ded06EEC12F5A9E3D09A2',
    lendingToken: '0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C', // kUSDRIF (Tropykus)
    stablecoin: '0x3A15461d8aE0F0Fb5Fa2629e9DA7D66A794a6e37', // USDRIF
    protocol: 'tropykus',
  },
]

async function tvl(api) {
  await Promise.all(handlers.map(async ({ handler, lendingToken, stablecoin, protocol }) => {
    if (protocol === 'tropykus') {
      const [receiptBalance, exchangeRate] = await Promise.all([
        api.call({ target: lendingToken, abi: 'erc20:balanceOf', params: [handler] }),
        api.call({ target: lendingToken, abi: 'uint256:exchangeRateStored' }),
      ])
      api.add(stablecoin, BigInt(receiptBalance) * BigInt(exchangeRate) / (10n ** 18n))
      return
    }

    if (protocol === 'sovryn') {
      const [loanToken, underlyingBalance] = await Promise.all([
        api.call({ target: lendingToken, abi: 'address:loanTokenAddress' }),
        api.call({ target: lendingToken, abi: 'function assetBalanceOf(address) view returns (uint256)', params: [handler] }),
      ])
      api.add(loanToken, underlyingBalance)
      return
    }

    throw new Error(`Unknown lending protocol: ${protocol}`)
  }))
}

module.exports = {
  doublecounted: true,
  methodology: 'TVL is the underlying stablecoin value held by legacy BitChill DCA handlers on Rootstock. Tropykus values kToken balances with exchangeRateStored. Sovryn values handler assets and attributes them to loanTokenAddress. Accumulated rBTC remains excluded.',
  rsk: {
    tvl,
  }
};
