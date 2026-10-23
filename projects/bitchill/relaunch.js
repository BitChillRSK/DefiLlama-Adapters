const { legacyTvl, LEGACY_ADDRESSES } = require('./legacy')

// The relaunch contracts are not deployed. This stays null until a later
// address-only change supplies the verified deployment manifest.
// While it is null the relaunch readers make no call and add nothing.
// The `bitchill` and `bitchill-idle` adapters both read this one manifest.
//
// Manifest shape (every address is a BitChill relaunch address or a token):
// {
//   verified: true,                 // a human approved this manifest after deployment
//   protocolVersion: '<version>',
//   chainId: 30,
//   startBlock: <first block at which OperationsAdmin has every listed handler assigned>,
//   dcaManager: '0x...',
//   operationsAdmin: '0x...',
//   tokens: { DOC: '0x...', USDRIF: '0x...', USDT0: '0x...' },
//   handlers: [{ token: 'DOC', routeIndex: 0, handler: '0x...' }, ...],
//   activePairs: ['DOC:0', ...],    // optional: an explicit subset of the seven pairs
// }
const RELAUNCH_MANIFEST = null

const RSK_CHAIN_ID = 30

// Route indexes of the relaunch map. Index 1 is LayerBank here (it was Tropykus in legacy).
// Indexes 3 and 4 are not available.
//
// Each route has one accounting category. DefiLlama applies `doublecounted` to a whole
// adapter, so each category has its own adapter: idle cash is in `bitchill-idle` (not
// double counted) and lender positions are in `bitchill` (double counted). A handler has
// one route, so it is in one adapter only.
const ROUTES = {
  0: { protocol: 'idle', category: 'idle' },
  1: { protocol: 'layerbank', category: 'lending' },
  2: { protocol: 'sovryn', category: 'lending' },
}
const CATEGORIES = ['idle', 'lending']

// Stablecoins and third-party lender tokens on Rootstock mainnet.
// These are not BitChill deployment addresses.
const TOKENS = {
  DOC: {
    address: '0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db',
    decimals: 18,
    routes: [0, 1, 2],
    layerBankAToken: '0x3F04280C66314b78E9712A41BF8C1A214460cAa2', // lRooDOC
    sovrynIToken: '0xd8D25f03EBbA94E15Df2eD4d6D38276B595593c1', // iDOC
  },
  USDRIF: {
    address: '0x3A15461d8aE0F0Fb5Fa2629e9DA7D66A794a6e37',
    decimals: 18,
    routes: [0, 1],
    layerBankAToken: '0xc96fBD12bE56Dd565b258d243344bCf792A51128', // lRooUSDRIF
  },
  USDT0: {
    address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
    decimals: 6,
    routes: [0, 1],
    layerBankAToken: '0x6bE7d4cfCe825b106aa88F6916A412c5af230Ec0', // lRooUSDT0
  },
}

const SUPPORTED_PAIRS = Object.entries(TOKENS)
  .flatMap(([symbol, { routes }]) => routes.map(routeIndex => `${symbol}:${routeIndex}`))

const LAYERBANK_RATE_SCALE = 10n ** 27n // Aave liquidity index (RAY)
const SOVRYN_RATE_SCALE = 10n ** 18n

const ABI = {
  balanceOf: 'erc20:balanceOf',
  scaledBalanceOf: 'function scaledBalanceOf(address) view returns (uint256)',
  pool: 'address:POOL',
  getReserveNormalizedIncome: 'function getReserveNormalizedIncome(address) view returns (uint256)',
  tokenPrice: 'uint256:tokenPrice',
  getHandler: 'function getHandler(address token, uint256 routeIndex) view returns (address)',
}

const MANIFEST_KEYS = ['verified', 'protocolVersion', 'chainId', 'startBlock', 'dcaManager', 'operationsAdmin', 'tokens', 'handlers', 'activePairs']
const HANDLER_KEYS = ['token', 'routeIndex', 'handler']
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function fail(message) {
  throw new Error(`Invalid BitChill relaunch manifest: ${message}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${label} has unknown field ${key}`)
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) fail(`${label} is not a valid address`)
  if (value.toLowerCase() === ZERO_ADDRESS) fail(`${label} is the zero address`)
  return value
}

// Checks a manifest and returns the deployment the reader uses. It throws on any defect.
function validateRelaunchManifest(manifest) {
  if (!isPlainObject(manifest)) fail('manifest is not an object')
  requireKnownKeys(manifest, MANIFEST_KEYS, 'manifest')

  if (manifest.verified !== true) fail('manifest is not marked as verified')
  if (typeof manifest.protocolVersion !== 'string' || manifest.protocolVersion.trim() === '')
    fail('protocolVersion is missing')
  if (manifest.chainId !== RSK_CHAIN_ID) fail(`chainId must be ${RSK_CHAIN_ID}`)
  if (!Number.isSafeInteger(manifest.startBlock) || manifest.startBlock <= 0)
    fail('startBlock must be a positive integer')

  const bitchillAddresses = [
    ['dcaManager', requireAddress(manifest.dcaManager, 'dcaManager')],
    ['operationsAdmin', requireAddress(manifest.operationsAdmin, 'operationsAdmin')],
  ]

  if (!isPlainObject(manifest.tokens)) fail('tokens is not an object')
  requireKnownKeys(manifest.tokens, Object.keys(TOKENS), 'tokens')
  for (const [symbol, { address }] of Object.entries(TOKENS)) {
    const supplied = requireAddress(manifest.tokens[symbol], `tokens.${symbol}`)
    if (supplied.toLowerCase() !== address.toLowerCase()) fail(`tokens.${symbol} is the wrong token`)
  }

  let expectedPairs = SUPPORTED_PAIRS
  if (manifest.activePairs !== undefined) {
    if (!Array.isArray(manifest.activePairs) || manifest.activePairs.length === 0)
      fail('activePairs must be a list with at least one pair')
    for (const pair of manifest.activePairs) {
      if (!SUPPORTED_PAIRS.includes(pair)) fail(`activePairs has unsupported pair ${String(pair)}`)
    }
    if (new Set(manifest.activePairs).size !== manifest.activePairs.length) fail('activePairs has a duplicate pair')
    expectedPairs = manifest.activePairs
  }

  if (!Array.isArray(manifest.handlers)) fail('handlers is not a list')
  const seenPairs = new Set()
  const handlers = manifest.handlers.map((entry, position) => {
    const label = `handlers[${position}]`
    if (!isPlainObject(entry)) fail(`${label} is not an object`)
    requireKnownKeys(entry, HANDLER_KEYS, label)

    const token = Object.hasOwn(TOKENS, entry.token) ? TOKENS[entry.token] : undefined
    if (!token) fail(`${label} has unknown token ${String(entry.token)}`)
    const pair = `${entry.token}:${String(entry.routeIndex)}`
    if (!Number.isInteger(entry.routeIndex) || !token.routes.includes(entry.routeIndex))
      fail(`${label} has unsupported pair ${pair}`)
    if (seenPairs.has(pair)) fail(`${label} repeats pair ${pair}`)
    seenPairs.add(pair)

    const handler = requireAddress(entry.handler, `${label}.handler`)
    bitchillAddresses.push([`${label}.handler`, handler])

    return Object.freeze({
      pair,
      symbol: entry.token,
      routeIndex: entry.routeIndex,
      protocol: ROUTES[entry.routeIndex].protocol,
      category: ROUTES[entry.routeIndex].category,
      handler,
      stablecoin: token.address,
      decimals: token.decimals,
      layerBankAToken: token.layerBankAToken,
      sovrynIToken: token.sovrynIToken,
    })
  })

  for (const pair of expectedPairs)
    if (!seenPairs.has(pair)) fail(`handler for pair ${pair} is missing`)
  for (const pair of seenPairs)
    if (!expectedPairs.includes(pair)) fail(`handler for pair ${pair} is not in activePairs`)

  // A BitChill address must be new: not repeated, not a token, not a lender token, not legacy.
  const taken = new Map()
  for (const address of LEGACY_ADDRESSES) taken.set(address.toLowerCase(), 'a legacy address')
  for (const [symbol, token] of Object.entries(TOKENS)) {
    taken.set(token.address.toLowerCase(), `token ${symbol}`)
    taken.set(token.layerBankAToken.toLowerCase(), `LayerBank aToken of ${symbol}`)
    if (token.sovrynIToken) taken.set(token.sovrynIToken.toLowerCase(), `Sovryn iToken of ${symbol}`)
  }
  for (const [label, address] of bitchillAddresses) {
    const key = address.toLowerCase()
    if (taken.has(key)) fail(`${label} duplicates ${taken.get(key)}`)
    taken.set(key, label)
  }

  return Object.freeze({
    protocolVersion: manifest.protocolVersion,
    chainId: manifest.chainId,
    startBlock: manifest.startBlock,
    dcaManager: manifest.dcaManager,
    operationsAdmin: manifest.operationsAdmin,
    handlers: Object.freeze(handlers),
  })
}

// The block of the supplied API. No other provider is asked.
async function resolveBlock(api) {
  const block = Number(api.block ?? await api.getBlock())
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('BitChill relaunch TVL needs a block number')
  return block
}

// Checks on chain, at the block of the supplied API, that OperationsAdmin has each manifest
// handler assigned to its token and route. A swapped or unrelated handler would report zero
// without an error, so any difference stops the adapter.
async function requireAssignedHandlers(api, { operationsAdmin, handlers }) {
  const assigned = await api.multiCall({
    target: operationsAdmin,
    abi: ABI.getHandler,
    calls: handlers.map(({ stablecoin, routeIndex }) => ({ params: [stablecoin, routeIndex] })),
  })
  if (!Array.isArray(assigned) || assigned.length !== handlers.length)
    throw new Error('BitChill relaunch TVL: OperationsAdmin did not answer for every pair')

  handlers.forEach(({ pair, handler }, position) => {
    const onChain = assigned[position]
    if (typeof onChain !== 'string' || onChain.toLowerCase() !== handler.toLowerCase())
      throw new Error(`BitChill relaunch TVL: the manifest handler of pair ${pair} is ${handler}, but OperationsAdmin has ${String(onChain)}`)
  })
}

// Underlying stablecoin of one handler. Each handler type has one source of value, so a
// receipt token and its underlying are never added together.
async function handlerUnderlying(api, { protocol, handler, stablecoin, layerBankAToken, sovrynIToken }) {
  if (protocol === 'idle')
    return BigInt(await api.call({ target: stablecoin, abi: ABI.balanceOf, params: [handler] }))

  if (protocol === 'layerbank') {
    const [scaledBalance, pool] = await Promise.all([
      api.call({ target: layerBankAToken, abi: ABI.scaledBalanceOf, params: [handler] }),
      api.call({ target: layerBankAToken, abi: ABI.pool }),
    ])
    const liquidityIndex = await api.call({ target: pool, abi: ABI.getReserveNormalizedIncome, params: [stablecoin] })
    return BigInt(scaledBalance) * BigInt(liquidityIndex) / LAYERBANK_RATE_SCALE
  }

  if (protocol === 'sovryn') {
    const [shares, tokenPrice] = await Promise.all([
      api.call({ target: sovrynIToken, abi: ABI.balanceOf, params: [handler] }),
      api.call({ target: sovrynIToken, abi: ABI.tokenPrice }),
    ])
    return BigInt(shares) * BigInt(tokenPrice) / SOVRYN_RATE_SCALE
  }

  throw new Error(`Unknown relaunch route: ${protocol}`)
}

// Builds the relaunch reader of one category ('idle' or 'lending'). It reads and adds only the
// handlers of that category. A null manifest, or a manifest with no handler of that category,
// gives a reader that does nothing.
// A manifest with a defect throws here, so a bad manifest cannot report a partial TVL.
function createRelaunchTvl(manifest, category) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown BitChill relaunch category: ${String(category)}`)
  if (manifest === null || manifest === undefined) return async () => {}

  const deployment = validateRelaunchManifest(manifest)
  const handlers = deployment.handlers.filter(entry => entry.category === category)
  if (handlers.length === 0) return async () => {}

  return async function relaunchTvl(api) {
    if (await resolveBlock(api) < deployment.startBlock) return

    // Every manifest handler is checked, not only this category. An adapter with no handler of its
    // category returns before this check, so a wrong on-chain assignment stops only the adapters that read.
    await requireAssignedHandlers(api, deployment)
    const amounts = await Promise.all(handlers.map(entry => handlerUnderlying(api, entry)))
    handlers.forEach(({ stablecoin }, position) => api.add(stablecoin, amounts[position]))
  }
}

// TVL function of the `bitchill` adapter (double counted): the legacy reader, then the
// relaunch lending reader. Every legacy handler is a lending handler. The two deployments
// keep separate readers and separate totals.
function createLendingTvl(manifest) {
  const relaunchLendingTvl = createRelaunchTvl(manifest, 'lending')

  return async function tvl(api) {
    await legacyTvl(api)
    await relaunchLendingTvl(api)
  }
}

// TVL function of the `bitchill-idle` adapter (not double counted): the relaunch idle reader.
// The legacy deployment has no idle handler.
function createIdleTvl(manifest) {
  return createRelaunchTvl(manifest, 'idle')
}

module.exports = {
  RELAUNCH_MANIFEST,
  SUPPORTED_PAIRS,
  TOKENS,
  validateRelaunchManifest,
  createRelaunchTvl,
  createLendingTvl,
  createIdleTvl,
}
