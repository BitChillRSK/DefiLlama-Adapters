const { RELAUNCH_MANIFEST, createIdleTvl } = require('../bitchill/relaunch')

// BitChill idle cash is not supplied to another protocol, so this adapter is not marked
// `doublecounted`. DefiLlama applies that mark to a whole adapter, so the BitChill lending
// handlers stay in the separate `bitchill` adapter, which keeps the mark.
module.exports = {
  methodology: 'TVL is the stablecoin held by BitChill relaunch idle DCA handlers on Rootstock. An idle handler keeps user deposits as the stablecoin until they are used for purchases, and does not supply them to another protocol. Idle handlers are counted only from the start block of a verified deployment manifest, as the stablecoin balance of each handler. BitChill lending handlers are not counted here: the separate bitchill adapter reports them as double counted. rBTC that was bought and waits for user withdrawal is excluded.',
  rsk: {
    // Relaunch idle reader. It does nothing while RELAUNCH_MANIFEST is null.
    tvl: createIdleTvl(RELAUNCH_MANIFEST),
  }
};
