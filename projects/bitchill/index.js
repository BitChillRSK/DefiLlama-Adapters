const { RELAUNCH_MANIFEST, createTvl } = require('./relaunch')

module.exports = {
  doublecounted: true,
  methodology: 'TVL is the underlying stablecoin value held by BitChill DCA handlers on Rootstock. Legacy handlers: Tropykus values kToken balances with exchangeRateStored. Sovryn values handler assets and attributes them to loanTokenAddress. Relaunch handlers are counted only from the start block of a verified deployment manifest: idle handlers count the stablecoin they hold, LayerBank handlers count the scaled aToken balance times the pool normalized income, and Sovryn handlers count the iToken balance times tokenPrice. Sovryn positions are reported before any Sovryn exit fee. Each handler counts only its underlying stablecoin, never the receipt token. rBTC that was bought and waits for user withdrawal is excluded.',
  rsk: {
    // Legacy reader, then relaunch reader. The relaunch reader does nothing while RELAUNCH_MANIFEST is null.
    tvl: createTvl(RELAUNCH_MANIFEST),
  }
};
