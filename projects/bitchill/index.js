const { legacyTvl } = require('./legacy')
const { RELAUNCH_MANIFEST, createRelaunchTvl } = require('./relaunch')

// Legacy and relaunch custody are two separate deployments with separate totals.
// The relaunch reader does nothing while RELAUNCH_MANIFEST is null.
const relaunchTvl = createRelaunchTvl(RELAUNCH_MANIFEST)

async function tvl(api) {
  await legacyTvl(api)
  await relaunchTvl(api)
}

module.exports = {
  doublecounted: true,
  methodology: 'TVL is the underlying stablecoin value held by BitChill DCA handlers on Rootstock. Legacy handlers: Tropykus values kToken balances with exchangeRateStored. Sovryn values handler assets and attributes them to loanTokenAddress. Relaunch handlers are counted only from the start block of a verified deployment manifest: idle handlers count the stablecoin they hold, LayerBank handlers count the scaled aToken balance times the pool normalized income, and Sovryn handlers count the iToken balance times tokenPrice. Each handler counts only its underlying stablecoin, never the receipt token. rBTC that was bought and waits for user withdrawal is excluded.',
  rsk: {
    tvl,
  }
};
