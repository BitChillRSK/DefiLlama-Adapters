const { RELAUNCH_MANIFEST, createLendingTvl } = require('./relaunch')

module.exports = {
  doublecounted: true,
  methodology: 'TVL is the underlying stablecoin value held by BitChill DCA lending handlers on Rootstock. Legacy handlers: Tropykus values kToken balances with exchangeRateStored. Sovryn values handler assets and attributes them to loanTokenAddress. Relaunch lending handlers are counted only from the start block of a verified deployment manifest: LayerBank handlers count the scaled aToken balance times the pool normalized income, and Sovryn handlers count the iToken balance times tokenPrice. Sovryn positions are reported before any Sovryn exit fee. Relaunch idle handlers are not counted here: the separate bitchill-idle adapter reports them. Each handler counts only its underlying stablecoin, never the receipt token. rBTC that was bought and waits for user withdrawal is excluded.',
  rsk: {
    // Legacy reader, then relaunch lending reader. The relaunch reader does nothing while RELAUNCH_MANIFEST is null.
    tvl: createLendingTvl(RELAUNCH_MANIFEST),
  }
};
