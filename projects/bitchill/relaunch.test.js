const assert = require('node:assert/strict')
const test = require('node:test')

const adapter = require('./index')
const idleAdapter = require('../bitchill-idle')
const { legacyTvl, LEGACY_ADDRESSES } = require('./legacy')
const {
  RELAUNCH_MANIFEST,
  SUPPORTED_PAIRS,
  TOKENS,
  validateRelaunchManifest,
  createRelaunchTvl,
  createLendingTvl,
  createIdleTvl,
} = require('./relaunch')

// Fixture addresses only. None of them is a deployed BitChill relaunch contract.
const fixtureAddress = suffix => `0x${'f1'.repeat(18)}${suffix.toString(16).padStart(4, '0')}`
const DCA_MANAGER = fixtureAddress(0x0001)
const OPERATIONS_ADMIN = fixtureAddress(0x0002)
// One pool per aToken, so a reader that reuses the pool of another token fails.
const POOLS = {
  DOC: fixtureAddress(0x00aa),
  USDRIF: fixtureAddress(0x00ab),
  USDT0: fixtureAddress(0x00ac),
}
const HANDLERS = {
  'DOC:0': fixtureAddress(0x0100),
  'DOC:1': fixtureAddress(0x0101),
  'DOC:2': fixtureAddress(0x0102),
  'USDRIF:0': fixtureAddress(0x0200),
  'USDRIF:1': fixtureAddress(0x0201),
  'USDT0:0': fixtureAddress(0x0300),
  'USDT0:1': fixtureAddress(0x0301),
}
const START_BLOCK = 9500000

const DOC = TOKENS.DOC.address
const USDRIF = TOKENS.USDRIF.address
const USDT0 = TOKENS.USDT0.address
const WRBTC = '0x542fDA317318eBF1d3DEAf76E0b632741A7e677d'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const ABI_BALANCE_OF = 'erc20:balanceOf'
const ABI_SCALED_BALANCE_OF = 'function scaledBalanceOf(address) view returns (uint256)'
const ABI_POOL = 'address:POOL'
const ABI_NORMALIZED_INCOME = 'function getReserveNormalizedIncome(address) view returns (uint256)'
const ABI_TOKEN_PRICE = 'uint256:tokenPrice'
const ABI_GET_HANDLER = 'function getHandler(address token, uint256 routeIndex) view returns (address)'

const RAY = 10n ** 27n
const WAD = 10n ** 18n

function fixtureManifest(overrides = {}) {
  return {
    verified: true,
    protocolVersion: 'fixture-2',
    chainId: 30,
    startBlock: START_BLOCK,
    dcaManager: DCA_MANAGER,
    operationsAdmin: OPERATIONS_ADMIN,
    tokens: { DOC, USDRIF, USDT0 },
    handlers: Object.entries(HANDLERS).map(([pair, handler]) => {
      const [token, routeIndex] = pair.split(':')
      return { token, routeIndex: Number(routeIndex), handler }
    }),
    ...overrides,
  }
}

function callKey({ target, abi, params = [] }) {
  return `${target.toLowerCase()}|${abi}|${params.join(',').toLowerCase()}`
}

// The SDK gives zero ABI inputs to a `type:name` shorthand. Only `erc20:balanceOf` and a
// complete signature can carry an argument. This check runs before the fixture lookup.
function validateAbi({ abi, params = [] }) {
  if (abi === ABI_BALANCE_OF) return assert.equal(params.length, 1)
  if (/^\w+:\w+$/.test(abi)) return assert.equal(params.length, 0, `${abi} declares zero ABI inputs`)
  const signature = /^function \w+\(([^)]*)\) view returns \((?:uint256|address)\)$/.exec(abi)
  assert.ok(signature, `unsupported ABI: ${abi}`)
  assert.equal(params.length, signature[1].split(',').filter(Boolean).length)
}

// Fake block-scoped ChainApi. Fixtures are stored per block, so a read at another block fails.
function createApi(block, responsesByBlock, { lazyBlock = false } = {}) {
  const api = {
    block: lazyBlock ? undefined : block,
    calls: [],
    multiCalls: [],
    adds: [],
    balances: {},
    getBlockCalls: 0,
    async getBlock() {
      this.getBlockCalls += 1
      this.block = block
      return block
    },
    async call(request) {
      assert.deepEqual(Object.keys(request).sort(), request.params ? ['abi', 'params', 'target'] : ['abi', 'target'])
      this.calls.push({ block: this.block, key: callKey(request), ...request })
      validateAbi(request)
      const response = (responsesByBlock[this.block] ?? {})[callKey(request)]
      assert.notEqual(response, undefined, `unexpected call at block ${this.block}: ${callKey(request)}`)
      return response
    },
    // One batched read, as ChainApi.multiCall: one target and ABI, a list of { params }.
    async multiCall(request) {
      assert.deepEqual(Object.keys(request).sort(), ['abi', 'calls', 'target'])
      this.multiCalls.push({ block: this.block, ...request })
      return request.calls.map(entry => {
        assert.deepEqual(Object.keys(entry), ['params'])
        const single = { target: request.target, abi: request.abi, params: entry.params }
        validateAbi(single)
        const response = (responsesByBlock[this.block] ?? {})[callKey(single)]
        assert.notEqual(response, undefined, `unexpected call at block ${this.block}: ${callKey(single)}`)
        return response
      })
    },
    add(token, amount) {
      assert.equal(typeof amount, 'bigint')
      const key = token.toLowerCase()
      this.adds.push({ token: key, amount })
      this.balances[key] = (this.balances[key] ?? 0n) + amount
    },
  }
  return api
}

const getHandlerKey = pair => {
  const [symbol, routeIndex] = pair.split(':')
  return callKey({ target: OPERATIONS_ADMIN, abi: ABI_GET_HANDLER, params: [TOKENS[symbol].address, Number(routeIndex)] })
}

// Builds the lender, token and OperationsAdmin responses for a custody state.
// state: { 'DOC:0': cash, 'DOC:1': { scaled, index }, 'DOC:2': { shares, price }, ... }
// assigned: what OperationsAdmin.getHandler returns for a pair, when it differs from the manifest.
function custodyResponses(state, assigned = {}) {
  const responses = {}
  for (const [pair, value] of Object.entries(state)) {
    const [symbol, routeIndex] = pair.split(':')
    const token = TOKENS[symbol]
    const handler = HANDLERS[pair]
    responses[getHandlerKey(pair)] = assigned[pair] ?? handler
    if (routeIndex === '0') {
      responses[callKey({ target: token.address, abi: ABI_BALANCE_OF, params: [handler] })] = value
    } else if (routeIndex === '1') {
      responses[callKey({ target: token.layerBankAToken, abi: ABI_SCALED_BALANCE_OF, params: [handler] })] = value.scaled
      responses[callKey({ target: token.layerBankAToken, abi: ABI_POOL })] = POOLS[symbol]
      responses[callKey({ target: POOLS[symbol], abi: ABI_NORMALIZED_INCOME, params: [token.address] })] = value.index
    } else {
      responses[callKey({ target: token.sovrynIToken, abi: ABI_BALANCE_OF, params: [handler] })] = value.shares
      responses[callKey({ target: token.sovrynIToken, abi: ABI_TOKEN_PRICE })] = value.price
    }
  }
  return responses
}

// Amounts are decimal strings, as the SDK returns them.
const SEVEN_PAIR_STATE = {
  'DOC:0': '1000000000000000000001', // 1000 DOC and 1 wei
  'DOC:1': { scaled: '2000000000000000000000', index: '1050000000000000000000000001' },
  'DOC:2': { shares: '3000000000000000000000', price: '1234567890123456789' },
  'USDRIF:0': '400000000000000000000',
  'USDRIF:1': { scaled: '7', index: '1500000000000000000000000001' },
  'USDT0:0': '2500000001', // 2500.000001 USDT0 (6 decimals)
  'USDT0:1': { scaled: '999999999', index: '1000000002000000000000000000' },
}

const SEVEN_PAIR_EXPECTED = {
  'DOC:0': 1000000000000000000001n,
  'DOC:1': 2000000000000000000000n * 1050000000000000000000000001n / RAY,
  'DOC:2': 3000000000000000000000n * 1234567890123456789n / WAD,
  'USDRIF:0': 400000000000000000000n,
  'USDRIF:1': 7n * 1500000000000000000000000001n / RAY,
  'USDT0:0': 2500000001n,
  'USDT0:1': 999999999n * 1000000002000000000000000000n / RAY,
}

const LEGACY_RESPONSES = (() => {
  const [docHandler, kDoc, sovrynHandler, iSusd, usdrifHandler, kUsdrif] = LEGACY_ADDRESSES
  return {
    [callKey({ target: kDoc, abi: ABI_BALANCE_OF, params: [docHandler] })]: '556968978106113842346',
    [callKey({ target: kDoc, abi: 'uint256:exchangeRateStored' })]: '27486894857292326',
    [callKey({ target: kUsdrif, abi: ABI_BALANCE_OF, params: [usdrifHandler] })]: '735057481902953',
    [callKey({ target: kUsdrif, abi: 'uint256:exchangeRateStored' })]: '22730764780911638',
    [callKey({ target: iSusd, abi: 'address:loanTokenAddress' })]: DOC,
    [callKey({ target: iSusd, abi: 'function assetBalanceOf(address) view returns (uint256)', params: [sovrynHandler] })]: '1454252674737243840448',
  }
})()
const LEGACY_EXPECTED = {
  [DOC.toLowerCase()]: 15309347739976302686n + 1454252674737243840448n,
  [USDRIF.toLowerCase()]: 16708418721585n,
}

// The legacy reader passes the Sovryn amount as the SDK returned it. This fake API accepts
// bigint only, so legacy runs use a wrapper that converts, as the SDK balance store does.
function createLegacyApi(block, responsesByBlock) {
  const api = createApi(block, responsesByBlock)
  const strictAdd = api.add
  api.add = (token, amount) => strictAdd.call(api, token, BigInt(amount))
  return api
}

function sumByToken(expectedByPair) {
  const totals = {}
  for (const [pair, amount] of Object.entries(expectedByPair)) {
    const key = TOKENS[pair.split(':')[0]].address.toLowerCase()
    totals[key] = (totals[key] ?? 0n) + amount
  }
  return totals
}

// Route 0 is idle cash (the `bitchill-idle` adapter). Routes 1 and 2 are lender positions (the `bitchill` adapter).
const IDLE_PAIRS = SUPPORTED_PAIRS.filter(pair => pair.endsWith(':0'))
const LENDING_PAIRS = SUPPORTED_PAIRS.filter(pair => !pair.endsWith(':0'))
const CATEGORY_PAIRS = { idle: IDLE_PAIRS, lending: LENDING_PAIRS }
// Custody reads per handler: idle 1, LayerBank 3, Sovryn 2.
const CATEGORY_CALLS = { idle: 3, lending: 3 + 3 + 3 + 2 }

const pick = (byPair, pairs) => Object.fromEntries(pairs.filter(pair => pair in byPair).map(pair => [pair, byPair[pair]]))
const assignmentCalls = pairs => pairs.map(pair => ({ params: [TOKENS[pair.split(':')[0]].address, Number(pair.split(':')[1])] }))
const relaunchReaders = manifest => ({
  idle: createRelaunchTvl(manifest, 'idle'),
  lending: createRelaunchTvl(manifest, 'lending'),
})

// A fixture manifest with an explicit active subset and only the handlers of that subset.
const subsetManifest = pairs => fixtureManifest({
  activePairs: pairs,
  handlers: fixtureManifest().handlers.filter(({ token, routeIndex }) => pairs.includes(`${token}:${routeIndex}`)),
})

// An API that fails on any use. A reader with nothing to read must not touch it.
const untouchableApi = () => new Proxy({}, {
  get(_, property) {
    if (property === 'then') return undefined
    throw new Error(`relaunch reader used api.${String(property)} with nothing to read`)
  },
})

test('ships no relaunch manifest and the adapter result equals the legacy reader alone', async () => {
  assert.equal(RELAUNCH_MANIFEST, null)
  assert.equal(adapter.doublecounted, true)
  assert.deepEqual(Object.keys(adapter).sort(), ['doublecounted', 'methodology', 'rsk'])

  const block = 9294353
  const legacyOnly = createLegacyApi(block, { [block]: LEGACY_RESPONSES })
  await legacyTvl(legacyOnly)

  const whole = createLegacyApi(block, { [block]: LEGACY_RESPONSES })
  await adapter.rsk.tvl(whole)

  assert.deepEqual(whole.balances, LEGACY_EXPECTED)
  assert.deepEqual(whole.balances, legacyOnly.balances)
  assert.deepEqual(whole.adds, legacyOnly.adds)
  assert.deepEqual(whole.calls, legacyOnly.calls)
  assert.equal(whole.calls.length, 6)
  assert.equal(whole.getBlockCalls, 0)
})

test('a missing manifest gives a reader that never uses the API', async () => {
  const untouchable = untouchableApi()

  for (const category of ['idle', 'lending']) {
    await createRelaunchTvl(null, category)(untouchable)
    await createRelaunchTvl(undefined, category)(untouchable)
  }
  // The idle adapter is the relaunch idle reader only, so it never uses the API.
  await createIdleTvl(null)(untouchable)
  await idleAdapter.rsk.tvl(untouchable)

  // The lending composition used by index.js makes the six legacy reads only.
  const api = createLegacyApi(START_BLOCK + 10, { [START_BLOCK + 10]: LEGACY_RESPONSES })
  await createLendingTvl(null)(api)
  assert.equal(api.calls.length, 6)
  assert.deepEqual(api.multiCalls, [])
  assert.equal(api.getBlockCalls, 0)
  assert.deepEqual(api.balances, LEGACY_EXPECTED)
})

test('lists exactly the seven supported pairs with their decimals', () => {
  assert.deepEqual(SUPPORTED_PAIRS, ['DOC:0', 'DOC:1', 'DOC:2', 'USDRIF:0', 'USDRIF:1', 'USDT0:0', 'USDT0:1'])
  assert.deepEqual(Object.keys(HANDLERS), SUPPORTED_PAIRS)
  assert.equal(TOKENS.DOC.decimals, 18)
  assert.equal(TOKENS.USDRIF.decimals, 18)
  assert.equal(TOKENS.USDT0.decimals, 6)
})

test('counts one underlying amount per handler for all seven pairs with exact integer math', async () => {
  const block = START_BLOCK + 10
  const readers = relaunchReaders(fixtureManifest())
  const apis = {}
  for (const category of ['idle', 'lending']) {
    apis[category] = createApi(block, { [block]: custodyResponses(SEVEN_PAIR_STATE) })
    await readers[category](apis[category])
  }

  // One add per handler of the category, in manifest order, each with the handler's own stablecoin.
  const addsOf = pairs => pairs.map(pair => ({ token: TOKENS[pair.split(':')[0]].address.toLowerCase(), amount: SEVEN_PAIR_EXPECTED[pair] }))
  assert.deepEqual(apis.idle.adds, addsOf(IDLE_PAIRS))
  assert.deepEqual(apis.lending.adds, addsOf(LENDING_PAIRS))

  // Hand-checked values: integer floors, 18 decimals and 6 decimals.
  assert.equal(SEVEN_PAIR_EXPECTED['DOC:1'], 2100000000000000000000n)
  assert.equal(SEVEN_PAIR_EXPECTED['DOC:2'], 3703703670370370367000n)
  assert.equal(SEVEN_PAIR_EXPECTED['USDRIF:1'], 10n)
  assert.equal(SEVEN_PAIR_EXPECTED['USDT0:1'], 1000000000n) // 1000000000.999999998 floors

  // Exact token keys: the three stablecoins and nothing else.
  assert.deepEqual(apis.idle.balances, {
    [DOC.toLowerCase()]: 1000000000000000000001n,
    [USDRIF.toLowerCase()]: 400000000000000000000n,
    [USDT0.toLowerCase()]: 2500000001n,
  })
  assert.deepEqual(apis.lending.balances, {
    [DOC.toLowerCase()]: 2100000000000000000000n + 3703703670370370367000n,
    [USDRIF.toLowerCase()]: 10n,
    [USDT0.toLowerCase()]: 1000000000n,
  })
  for (const api of Object.values(apis)) {
    for (const token of Object.values(TOKENS)) {
      assert.equal(api.balances[token.layerBankAToken.toLowerCase()], undefined)
      if (token.sovrynIToken) assert.equal(api.balances[token.sovrynIToken.toLowerCase()], undefined)
    }
  }
})

test('makes exactly the expected reads and every read uses the supplied block', async () => {
  const block = START_BLOCK + 10
  const responses = custodyResponses(SEVEN_PAIR_STATE)
  const custodyKeys = Object.keys(responses).filter(key => !key.includes(ABI_GET_HANDLER))
  const readers = relaunchReaders(fixtureManifest())
  const apis = {}

  for (const category of ['idle', 'lending']) {
    const api = createApi(block, { [block]: responses })
    await readers[category](api)
    apis[category] = api

    assert.equal(api.calls.length, CATEGORY_CALLS[category])
    for (const call of api.calls) assert.equal(call.block, block)
    assert.equal(api.getBlockCalls, 0)

    // One batched OperationsAdmin read checks all seven assignments, at the same block.
    assert.deepEqual(api.multiCalls, [{
      block,
      target: OPERATIONS_ADMIN,
      abi: ABI_GET_HANDLER,
      calls: assignmentCalls(SUPPORTED_PAIRS),
    }])

    // No handler, DcaManager or OperationsAdmin is a call target: custody is read from tokens and lenders.
    const targets = new Set(api.calls.map(call => call.target.toLowerCase()))
    for (const address of [...Object.values(HANDLERS), DCA_MANAGER, OPERATIONS_ADMIN])
      assert.equal(targets.has(address.toLowerCase()), false)
  }

  // The two readers make every custody read once between them.
  const idleKeys = apis.idle.calls.map(call => call.key)
  const lendingKeys = apis.lending.calls.map(call => call.key)
  assert.deepEqual(new Set([...idleKeys, ...lendingKeys]), new Set(custodyKeys))
  for (const key of idleKeys) assert.equal(lendingKeys.includes(key), false)
  for (const call of apis.idle.calls) assert.equal(call.abi, ABI_BALANCE_OF)

  // Each LayerBank index is read from the pool of its own aToken.
  for (const [symbol, pool] of Object.entries(POOLS)) {
    const indexReads = apis.lending.calls.filter(call => call.abi === ABI_NORMALIZED_INCOME && call.params[0] === TOKENS[symbol].address)
    assert.deepEqual(indexReads.map(call => call.target), [pool])
  }
})

test('a read at a block without a fixture fails instead of using another block', async () => {
  const fixtureBlock = START_BLOCK + 10
  for (const relaunchTvl of Object.values(relaunchReaders(fixtureManifest()))) {
    const api = createApi(START_BLOCK + 11, { [fixtureBlock]: custodyResponses(SEVEN_PAIR_STATE) })

    await assert.rejects(relaunchTvl(api), /unexpected call at block 9500011/)
    assert.deepEqual(api.adds, [])
  }
})

test('empty handlers add zero for each stablecoin', async () => {
  const block = START_BLOCK
  const responses = custodyResponses({
    'DOC:0': '0',
    'DOC:1': { scaled: '0', index: '1050000000000000000000000001' },
    'DOC:2': { shares: '0', price: '1234567890123456789' },
    'USDRIF:0': '0',
    'USDRIF:1': { scaled: '0', index: '1500000000000000000000000001' },
    'USDT0:0': '0',
    'USDT0:1': { scaled: '0', index: '1000000002000000000000000000' },
  })

  const readers = relaunchReaders(fixtureManifest())
  for (const category of ['idle', 'lending']) {
    const api = createApi(block, { [block]: responses })
    await readers[category](api)

    assert.equal(api.adds.length, CATEGORY_PAIRS[category].length)
    assert.deepEqual(api.balances, {
      [DOC.toLowerCase()]: 0n,
      [USDRIF.toLowerCase()]: 0n,
      [USDT0.toLowerCase()]: 0n,
    })
  }
})

test('skips every relaunch read before the deployment start block and reads from it', async () => {
  const readers = relaunchReaders(fixtureManifest())
  const responses = custodyResponses(SEVEN_PAIR_STATE)

  for (const category of ['idle', 'lending']) {
    const relaunchTvl = readers[category]
    for (const block of [9200000, 9294353, START_BLOCK - 1]) {
      const before = createApi(block, { [block]: responses })
      await relaunchTvl(before)
      assert.deepEqual(before.calls, [])
      assert.deepEqual(before.multiCalls, [])
      assert.deepEqual(before.adds, [])
      assert.deepEqual(before.balances, {})
    }

    const atStart = createApi(START_BLOCK, { [START_BLOCK]: responses })
    await relaunchTvl(atStart)
    assert.equal(atStart.calls.length, CATEGORY_CALLS[category])
    assert.equal(atStart.multiCalls.length, 1)
    assert.equal(atStart.multiCalls[0].block, START_BLOCK)
    assert.deepEqual(atStart.balances, sumByToken(pick(SEVEN_PAIR_EXPECTED, CATEGORY_PAIRS[category])))
  }
})

test('resolves an unset block through the supplied API only', async () => {
  const readers = relaunchReaders(fixtureManifest())
  const responses = custodyResponses(SEVEN_PAIR_STATE)

  for (const category of ['idle', 'lending']) {
    const relaunchTvl = readers[category]

    const early = createApi(START_BLOCK - 1, { [START_BLOCK - 1]: responses }, { lazyBlock: true })
    await relaunchTvl(early)
    assert.equal(early.getBlockCalls, 1)
    assert.deepEqual(early.calls, [])
    assert.deepEqual(early.multiCalls, [])

    const late = createApi(START_BLOCK + 5, { [START_BLOCK + 5]: responses }, { lazyBlock: true })
    await relaunchTvl(late)
    assert.equal(late.getBlockCalls, 1)
    assert.equal(late.calls.length, CATEGORY_CALLS[category])
    for (const call of [...late.calls, ...late.multiCalls]) assert.equal(call.block, START_BLOCK + 5)

    const noBlock = { block: undefined, getBlock: async () => undefined, call: async () => assert.fail('no read expected'), multiCall: async () => assert.fail('no read expected'), add: () => assert.fail('no add expected') }
    await assert.rejects(relaunchTvl(noBlock), /needs a block number/)
  }
})

test('stops when OperationsAdmin does not have a manifest handler assigned to its pair', async t => {
  const block = START_BLOCK + 10
  const unrelated = fixtureAddress(0x0bad)
  const cases = [
    ['swapped idle and LayerBank handlers', { 'DOC:0': HANDLERS['DOC:1'], 'DOC:1': HANDLERS['DOC:0'] }, 'DOC:0', HANDLERS['DOC:1']],
    ['swapped handlers of two tokens', { 'USDRIF:0': HANDLERS['USDT0:0'], 'USDT0:0': HANDLERS['USDRIF:0'] }, 'USDRIF:0', HANDLERS['USDT0:0']],
    ['an unrelated address', { 'USDT0:1': unrelated }, 'USDT0:1', unrelated],
    ['a zero return for a pair with no handler', { 'DOC:2': ZERO_ADDRESS }, 'DOC:2', ZERO_ADDRESS],
    ['an empty answer', { 'USDRIF:1': '' }, 'USDRIF:1', '$'],
  ]

  for (const [name, assigned, pair, onChain] of cases) {
    // Each adapter checks all seven assignments, so a wrong manifest stops both, also for a pair of the other category.
    for (const category of ['idle', 'lending']) {
      await t.test(`${name} (${category} reader)`, async () => {
        const api = createApi(block, { [block]: custodyResponses(SEVEN_PAIR_STATE, assigned) })

        await assert.rejects(createRelaunchTvl(fixtureManifest(), category)(api), error => {
          assert.match(error.message, new RegExp(`manifest handler of pair ${pair} is ${HANDLERS[pair]}, but OperationsAdmin has ${onChain}`))
          return true
        })
        // The check comes first: no custody read and no amount is reported.
        assert.equal(api.multiCalls.length, 1)
        assert.equal(api.multiCalls[0].block, block)
        assert.deepEqual(api.calls, [])
        assert.deepEqual(api.adds, [])
      })
    }
  }

  await t.test('a short OperationsAdmin answer', async () => {
    for (const relaunchTvl of Object.values(relaunchReaders(fixtureManifest()))) {
      const api = createApi(block, { [block]: custodyResponses(SEVEN_PAIR_STATE) })
      api.multiCall = async () => [HANDLERS['DOC:0']]
      await assert.rejects(relaunchTvl(api), /did not answer for every pair/)
      assert.deepEqual(api.adds, [])
    }
  })

  await t.test('each adapter fails as a whole, with no partial relaunch amount', async () => {
    const responses = { ...LEGACY_RESPONSES, ...custodyResponses(SEVEN_PAIR_STATE, { 'DOC:0': HANDLERS['DOC:1'], 'DOC:1': HANDLERS['DOC:0'] }) }
    const lendingApi = createLegacyApi(block, { [block]: responses })
    await assert.rejects(createLendingTvl(fixtureManifest())(lendingApi), /manifest handler of pair DOC:0/)
    assert.equal(lendingApi.balances[USDT0.toLowerCase()], undefined)

    const idleApi = createApi(block, { [block]: responses })
    await assert.rejects(createIdleTvl(fixtureManifest())(idleApi), /manifest handler of pair DOC:0/)
    assert.deepEqual(idleApi.adds, [])
  })
})

test('accepts an on-chain handler address that differs from the manifest only in letter case', async () => {
  const block = START_BLOCK + 10
  const upper = address => `0x${address.slice(2).toUpperCase()}`
  const assigned = Object.fromEntries(SUPPORTED_PAIRS.map(pair => [pair, upper(HANDLERS[pair])]))
  const readers = relaunchReaders(fixtureManifest())

  for (const category of ['idle', 'lending']) {
    const api = createApi(block, { [block]: custodyResponses(SEVEN_PAIR_STATE, assigned) })
    await readers[category](api)
    assert.deepEqual(api.balances, sumByToken(pick(SEVEN_PAIR_EXPECTED, CATEGORY_PAIRS[category])))
  }
})

test('accepts the fixture manifest and returns the seven handlers with their routes', () => {
  const deployment = validateRelaunchManifest(fixtureManifest())

  assert.equal(deployment.startBlock, START_BLOCK)
  assert.equal(deployment.protocolVersion, 'fixture-2')
  assert.equal(deployment.dcaManager, DCA_MANAGER)
  assert.equal(deployment.operationsAdmin, OPERATIONS_ADMIN)
  // Each handler has exactly one category: route 0 is idle, routes 1 and 2 are lending.
  assert.deepEqual(deployment.handlers.map(({ pair, protocol, category, handler, stablecoin, decimals }) => ({ pair, protocol, category, handler, stablecoin, decimals })), [
    { pair: 'DOC:0', protocol: 'idle', category: 'idle', handler: HANDLERS['DOC:0'], stablecoin: DOC, decimals: 18 },
    { pair: 'DOC:1', protocol: 'layerbank', category: 'lending', handler: HANDLERS['DOC:1'], stablecoin: DOC, decimals: 18 },
    { pair: 'DOC:2', protocol: 'sovryn', category: 'lending', handler: HANDLERS['DOC:2'], stablecoin: DOC, decimals: 18 },
    { pair: 'USDRIF:0', protocol: 'idle', category: 'idle', handler: HANDLERS['USDRIF:0'], stablecoin: USDRIF, decimals: 18 },
    { pair: 'USDRIF:1', protocol: 'layerbank', category: 'lending', handler: HANDLERS['USDRIF:1'], stablecoin: USDRIF, decimals: 18 },
    { pair: 'USDT0:0', protocol: 'idle', category: 'idle', handler: HANDLERS['USDT0:0'], stablecoin: USDT0, decimals: 6 },
    { pair: 'USDT0:1', protocol: 'layerbank', category: 'lending', handler: HANDLERS['USDT0:1'], stablecoin: USDT0, decimals: 6 },
  ])
})

test('rejects defective manifests', async t => {
  const handlersWith = change => fixtureManifest().handlers.map(entry => ({ ...entry, ...change(entry) }))
  const replaceHandler = (pair, change) => handlersWith(entry => `${entry.token}:${entry.routeIndex}` === pair ? change : {})
  const withoutField = field => {
    const manifest = fixtureManifest()
    delete manifest[field]
    return manifest
  }

  const cases = [
    ['a manifest that is not an object', 'manifest', /not an object/],
    ['a list in place of the manifest', [], /not an object/],
    ['an unknown field', fixtureManifest({ rbtcHolders: [] }), /unknown field rbtcHolders/],
    ['a manifest without the verified mark', withoutField('verified'), /not marked as verified/],
    ['an unverified manifest', fixtureManifest({ verified: 'true' }), /not marked as verified/],
    ['a missing protocol version', fixtureManifest({ protocolVersion: ' ' }), /protocolVersion is missing/],
    ['a wrong chain', fixtureManifest({ chainId: 31 }), /chainId must be 30/],
    ['a missing start block', withoutField('startBlock'), /startBlock must be a positive integer/],
    ['a zero start block', fixtureManifest({ startBlock: 0 }), /startBlock must be a positive integer/],
    ['a text start block', fixtureManifest({ startBlock: '9500000' }), /startBlock must be a positive integer/],
    ['a fractional start block', fixtureManifest({ startBlock: 9500000.5 }), /startBlock must be a positive integer/],
    ['a zero DcaManager', fixtureManifest({ dcaManager: ZERO_ADDRESS }), /dcaManager is the zero address/],
    ['a zero OperationsAdmin', fixtureManifest({ operationsAdmin: ZERO_ADDRESS }), /operationsAdmin is the zero address/],
    ['a missing OperationsAdmin', withoutField('operationsAdmin'), /operationsAdmin is not a valid address/],
    ['a short address', fixtureManifest({ dcaManager: DCA_MANAGER.slice(0, 41) }), /dcaManager is not a valid address/],
    ['an address without 0x', fixtureManifest({ dcaManager: DCA_MANAGER.slice(2) }), /dcaManager is not a valid address/],
    ['an address with a non-hex character', fixtureManifest({ dcaManager: `${DCA_MANAGER.slice(0, 41)}g` }), /dcaManager is not a valid address/],
    ['a numeric address', fixtureManifest({ operationsAdmin: 2 }), /operationsAdmin is not a valid address/],
    ['a zero handler', fixtureManifest({ handlers: replaceHandler('USDT0:1', { handler: ZERO_ADDRESS }) }), /handlers\[6\]\.handler is the zero address/],
    ['a structurally invalid handler', fixtureManifest({ handlers: replaceHandler('DOC:1', { handler: '0x1234' }) }), /handlers\[1\]\.handler is not a valid address/],
    ['two pairs with one handler', fixtureManifest({ handlers: replaceHandler('USDRIF:0', { handler: HANDLERS['DOC:0'] }) }), /handlers\[3\]\.handler duplicates handlers\[0\]\.handler/],
    ['a duplicate that differs only in letter case', fixtureManifest({ handlers: replaceHandler('USDRIF:0', { handler: HANDLERS['DOC:0'].toUpperCase().replace('0X', '0x') }) }), /duplicates handlers\[0\]\.handler/],
    ['a handler equal to DcaManager', fixtureManifest({ handlers: replaceHandler('DOC:2', { handler: DCA_MANAGER }) }), /handlers\[2\]\.handler duplicates dcaManager/],
    ['OperationsAdmin equal to DcaManager', fixtureManifest({ operationsAdmin: DCA_MANAGER }), /operationsAdmin duplicates dcaManager/],
    ['a handler equal to a stablecoin', fixtureManifest({ handlers: replaceHandler('DOC:0', { handler: DOC }) }), /duplicates token DOC/],
    ['a handler equal to a LayerBank aToken', fixtureManifest({ handlers: replaceHandler('USDT0:1', { handler: TOKENS.USDT0.layerBankAToken }) }), /duplicates LayerBank aToken of USDT0/],
    ['a handler equal to the Sovryn iToken', fixtureManifest({ handlers: replaceHandler('DOC:2', { handler: TOKENS.DOC.sovrynIToken }) }), /duplicates Sovryn iToken of DOC/],
    ['a handler equal to a legacy handler', fixtureManifest({ handlers: replaceHandler('DOC:1', { handler: LEGACY_ADDRESSES[0] }) }), /duplicates a legacy address/],
    ['DcaManager equal to a legacy receipt token', fixtureManifest({ dcaManager: LEGACY_ADDRESSES[1] }), /dcaManager duplicates a legacy address/],
    ['a wrong DOC token', fixtureManifest({ tokens: { DOC: USDRIF, USDRIF, USDT0 } }), /tokens\.DOC is the wrong token/],
    ['a wrong USDT0 token', fixtureManifest({ tokens: { DOC, USDRIF, USDT0: fixtureAddress(0x0999) } }), /tokens\.USDT0 is the wrong token/],
    ['a missing token', fixtureManifest({ tokens: { DOC, USDRIF } }), /tokens\.USDT0 is not a valid address/],
    ['a zero token', fixtureManifest({ tokens: { DOC, USDRIF: ZERO_ADDRESS, USDT0 } }), /tokens\.USDRIF is the zero address/],
    ['an extra token', fixtureManifest({ tokens: { DOC, USDRIF, USDT0, WRBTC } }), /tokens has unknown field WRBTC/],
    ['a handler for an unknown token', fixtureManifest({ handlers: replaceHandler('DOC:0', { token: 'WRBTC' }) }), /unknown token WRBTC/],
    ['a handler with an inherited object key as token', fixtureManifest({ handlers: replaceHandler('DOC:0', { token: 'constructor' }) }), /unknown token constructor/],
    ['USDRIF on Sovryn', fixtureManifest({ handlers: replaceHandler('USDRIF:1', { routeIndex: 2 }) }), /unsupported pair USDRIF:2/],
    ['USDT0 on Sovryn', fixtureManifest({ handlers: replaceHandler('USDT0:1', { routeIndex: 2 }) }), /unsupported pair USDT0:2/],
    ['route index 4', fixtureManifest({ handlers: replaceHandler('DOC:1', { routeIndex: 4 }) }), /unsupported pair DOC:4/],
    ['route index 3', fixtureManifest({ handlers: replaceHandler('DOC:1', { routeIndex: 3 }) }), /unsupported pair DOC:3/],
    ['a text route index', fixtureManifest({ handlers: replaceHandler('DOC:1', { routeIndex: '1' }) }), /unsupported pair DOC:1/],
    ['a repeated pair', fixtureManifest({ handlers: replaceHandler('DOC:1', { routeIndex: 0 }) }), /handlers\[1\] repeats pair DOC:0/],
    ['an extra handler field', fixtureManifest({ handlers: replaceHandler('DOC:0', { lendingToken: WRBTC }) }), /handlers\[0\] has unknown field lendingToken/],
    ['handlers that are not a list', fixtureManifest({ handlers: HANDLERS }), /handlers is not a list/],
    ['six handlers without an explicit subset', fixtureManifest({ handlers: fixtureManifest().handlers.slice(0, 6) }), /handler for pair USDT0:1 is missing/],
    ['no handlers', fixtureManifest({ handlers: [] }), /handler for pair DOC:0 is missing/],
    ['an empty active subset', fixtureManifest({ activePairs: [] }), /activePairs must be a list with at least one pair/],
    ['an active subset that is not a list', fixtureManifest({ activePairs: 'DOC:0' }), /activePairs must be a list/],
    ['an unsupported pair in the active subset', fixtureManifest({ activePairs: ['USDRIF:2'] }), /activePairs has unsupported pair USDRIF:2/],
    ['a repeated pair in the active subset', fixtureManifest({ activePairs: ['DOC:0', 'DOC:0'] }), /activePairs has a duplicate pair/],
    ['a handler outside the active subset', fixtureManifest({ activePairs: ['DOC:0', 'DOC:1'] }), /handler for pair DOC:2 is not in activePairs/],
    ['an active pair without a handler', fixtureManifest({ activePairs: SUPPORTED_PAIRS, handlers: fixtureManifest().handlers.slice(1) }), /handler for pair DOC:0 is missing/],
  ]

  for (const [name, manifest, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateRelaunchManifest(manifest), expected)
      // No reader can be built from a defective manifest, so neither adapter can report a partial TVL.
      for (const category of ['idle', 'lending'])
        assert.throws(() => createRelaunchTvl(manifest, category), /Invalid BitChill relaunch manifest/)
      assert.throws(() => createLendingTvl(manifest), /Invalid BitChill relaunch manifest/)
      assert.throws(() => createIdleTvl(manifest), /Invalid BitChill relaunch manifest/)
    })
  }
})

test('reads only the handlers of an explicit active subset', async () => {
  const manifest = subsetManifest(['DOC:0', 'USDT0:1'])
  const block = START_BLOCK + 1
  const responses = custodyResponses({ 'DOC:0': SEVEN_PAIR_STATE['DOC:0'], 'USDT0:1': SEVEN_PAIR_STATE['USDT0:1'] })
  const readers = relaunchReaders(manifest)

  const idleApi = createApi(block, { [block]: responses })
  await readers.idle(idleApi)
  const lendingApi = createApi(block, { [block]: responses })
  await readers.lending(lendingApi)

  assert.equal(idleApi.calls.length, 1)
  assert.equal(lendingApi.calls.length, 3)
  for (const api of [idleApi, lendingApi])
    assert.deepEqual(api.multiCalls.map(({ calls }) => calls), [[
      { params: [DOC, 0] },
      { params: [USDT0, 1] },
    ]])
  assert.deepEqual(idleApi.balances, { [DOC.toLowerCase()]: SEVEN_PAIR_EXPECTED['DOC:0'] })
  assert.deepEqual(lendingApi.balances, { [USDT0.toLowerCase()]: SEVEN_PAIR_EXPECTED['USDT0:1'] })
})

test('a stablecoin spent in a purchase is not counted again as rBTC', async () => {
  // DOC idle is a MoC-style handler: bought rBTC waits on it as native rBTC.
  // USDT0 LayerBank is a Uniswap-style handler: bought rBTC waits on it as WRBTC.
  // The fake API serves these rBTC and WRBTC balances and the user claims, so the
  // exclusion is proven against data that exists.
  const ABI_CLAIM = 'function getAccumulatedRbtcBalance(address) view returns (uint256)'
  const USER = fixtureAddress(0x0777)
  const mocHandler = HANDLERS['DOC:0']
  const dexHandler = HANDLERS['USDT0:1']
  const index = '1100000000000000000000000000'
  const idleOthers = { 'DOC:1': { scaled: '0', index }, 'DOC:2': { shares: '0', price: '1000000000000000000' }, 'USDRIF:0': '0', 'USDRIF:1': { scaled: '0', index }, 'USDT0:0': '0' }
  const states = [
    {
      name: 'before purchase',
      block: START_BLOCK + 100,
      custody: { 'DOC:0': '1000000000000000000000', 'USDT0:1': { scaled: '2000000000', index } },
      rbtc: { native: '0', wrbtc: '0' },
      expected: { doc: 1000000000000000000000n, usdt0: 2200000000n },
    },
    {
      name: 'after purchase, rBTC waits on the handlers',
      block: START_BLOCK + 200,
      // 250 DOC and 550 USDT0 (500000000 scaled shares) were sold for rBTC.
      custody: { 'DOC:0': '750000000000000000000', 'USDT0:1': { scaled: '1500000000', index } },
      rbtc: { native: '5000000000000000', wrbtc: '11000000000000000' },
      expected: { doc: 750000000000000000000n, usdt0: 1650000000n },
    },
    {
      name: 'after the users withdraw their rBTC',
      block: START_BLOCK + 300,
      custody: { 'DOC:0': '750000000000000000000', 'USDT0:1': { scaled: '1500000000', index } },
      rbtc: { native: '0', wrbtc: '0' },
      expected: { doc: 750000000000000000000n, usdt0: 1650000000n },
    },
  ]

  // The result is the sum of the two adapters: DOC:0 is idle cash, USDT0:1 is a lender position.
  const readers = relaunchReaders(fixtureManifest())
  const results = []
  for (const state of states) {
    const rbtcResponses = {
      [callKey({ target: WRBTC, abi: ABI_BALANCE_OF, params: [dexHandler] })]: state.rbtc.wrbtc,
      [callKey({ target: mocHandler, abi: ABI_CLAIM, params: [USER] })]: state.rbtc.native,
      [callKey({ target: dexHandler, abi: ABI_CLAIM, params: [USER] })]: state.rbtc.wrbtc,
    }
    const api = createApi(state.block, { [state.block]: { ...custodyResponses({ ...idleOthers, ...state.custody }), ...rbtcResponses } })
    // Native balances and a generic token sweep exist on this fake API and would report the rBTC.
    const nativeBalances = { [mocHandler.toLowerCase()]: state.rbtc.native }
    let otherReads = 0
    api.sumTokens = async ({ owners = [], tokens = [] }) => {
      otherReads += 1
      for (const owner of owners) {
        api.add(ZERO_ADDRESS, BigInt(nativeBalances[owner.toLowerCase()] ?? 0))
        for (const token of tokens)
          api.add(token, BigInt(rbtcResponses[callKey({ target: token, abi: ABI_BALANCE_OF, params: [owner] })] ?? 0))
      }
    }
    api.getGasTokenBalance = async owner => {
      otherReads += 1
      return nativeBalances[owner.toLowerCase()] ?? '0'
    }

    // The served rBTC data is real: a sweep of the two handlers would report it.
    await api.sumTokens({ owners: [mocHandler, dexHandler], tokens: [WRBTC] })
    assert.equal(api.balances[ZERO_ADDRESS], BigInt(state.rbtc.native), state.name)
    assert.equal(api.balances[WRBTC.toLowerCase()], BigInt(state.rbtc.wrbtc), state.name)
    api.balances = {}
    api.adds.length = 0
    otherReads = 0

    await readers.lending(api)
    await readers.idle(api)

    // Only stablecoin keys exist: no native rBTC, no WRBTC, no other asset.
    assert.deepEqual(api.balances, {
      [DOC.toLowerCase()]: state.expected.doc,
      [USDRIF.toLowerCase()]: 0n,
      [USDT0.toLowerCase()]: state.expected.usdt0,
    }, state.name)
    assert.equal(api.balances[ZERO_ADDRESS], undefined)
    assert.equal(api.balances[WRBTC.toLowerCase()], undefined)

    // The reader asked for none of the served rBTC data.
    assert.equal(otherReads, 0)
    const requested = new Set(api.calls.map(call => call.key))
    for (const key of Object.keys(rbtcResponses)) assert.equal(requested.has(key), false)
    for (const call of api.calls) {
      assert.ok([ABI_BALANCE_OF, ABI_SCALED_BALANCE_OF, ABI_POOL, ABI_NORMALIZED_INCOME, ABI_TOKEN_PRICE].includes(call.abi))
      assert.notEqual(call.target.toLowerCase(), WRBTC.toLowerCase())
      assert.equal(Object.values(HANDLERS).map(address => address.toLowerCase()).includes(call.target.toLowerCase()), false)
    }
    results.push(api.balances)
  }

  // The purchase lowers TVL by exactly the stablecoin sold. The rBTC adds nothing back.
  assert.equal(results[0][DOC.toLowerCase()] - results[1][DOC.toLowerCase()], 250000000000000000000n)
  assert.equal(results[0][USDT0.toLowerCase()] - results[1][USDT0.toLowerCase()], 550000000n)
  // The rBTC withdrawal does not change TVL.
  assert.deepEqual(results[2], results[1])
  assert.match(adapter.methodology, /rBTC that was bought and waits for user withdrawal is excluded/)
  assert.match(adapter.methodology, /Sovryn positions are reported before any Sovryn exit fee/)
  assert.match(idleAdapter.methodology, /rBTC that was bought and waits for user withdrawal is excluded/)
})

test('legacy and relaunch totals stay separate and add up in the compositions the two adapters use', async () => {
  const block = START_BLOCK + 10
  const relaunchResponses = custodyResponses(SEVEN_PAIR_STATE)
  const lendingExpected = sumByToken(pick(SEVEN_PAIR_EXPECTED, LENDING_PAIRS))
  const idleExpected = sumByToken(pick(SEVEN_PAIR_EXPECTED, IDLE_PAIRS))

  const legacyApi = createLegacyApi(block, { [block]: LEGACY_RESPONSES })
  await legacyTvl(legacyApi)
  assert.deepEqual(legacyApi.balances, LEGACY_EXPECTED)

  const relaunchApi = createApi(block, { [block]: relaunchResponses })
  await createRelaunchTvl(fixtureManifest(), 'lending')(relaunchApi)
  assert.deepEqual(relaunchApi.balances, lendingExpected)

  // No call is shared: each reader makes only its own reads.
  const legacyKeys = new Set(legacyApi.calls.map(call => call.key))
  for (const call of relaunchApi.calls) assert.equal(legacyKeys.has(call.key), false)

  // `bitchill` (index.js): legacy, then relaunch lending.
  const lendingApi = createLegacyApi(block, { [block]: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await createLendingTvl(fixtureManifest())(lendingApi)
  assert.equal(lendingApi.calls.length, 6 + CATEGORY_CALLS.lending)
  assert.equal(lendingApi.multiCalls.length, 1)
  for (const call of [...lendingApi.calls, ...lendingApi.multiCalls]) assert.equal(call.block, block)
  assert.deepEqual(lendingApi.balances, {
    [DOC.toLowerCase()]: LEGACY_EXPECTED[DOC.toLowerCase()] + lendingExpected[DOC.toLowerCase()],
    [USDRIF.toLowerCase()]: LEGACY_EXPECTED[USDRIF.toLowerCase()] + lendingExpected[USDRIF.toLowerCase()],
    [USDT0.toLowerCase()]: lendingExpected[USDT0.toLowerCase()],
  })

  // `bitchill-idle`: relaunch idle only, no legacy read.
  const idleApi = createLegacyApi(block, { [block]: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await createIdleTvl(fixtureManifest())(idleApi)
  assert.equal(idleApi.calls.length, CATEGORY_CALLS.idle)
  for (const call of idleApi.calls) assert.equal(legacyKeys.has(call.key), false)
  assert.deepEqual(idleApi.balances, idleExpected)

  // Before the start block the lending composition gives the legacy result only, and idle gives nothing.
  const earlyApi = createLegacyApi(9294353, { 9294353: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await createLendingTvl(fixtureManifest())(earlyApi)
  assert.deepEqual(earlyApi.balances, LEGACY_EXPECTED)
  assert.equal(earlyApi.calls.length, 6)
  assert.deepEqual(earlyApi.multiCalls, [])

  const earlyIdleApi = createLegacyApi(9294353, { 9294353: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await createIdleTvl(fixtureManifest())(earlyIdleApi)
  assert.deepEqual(earlyIdleApi.balances, {})
  assert.deepEqual(earlyIdleApi.calls, [])
  assert.deepEqual(earlyIdleApi.multiCalls, [])
})

test('the idle adapter is a separate listing without the double-counted classification', () => {
  assert.equal(adapter.doublecounted, true)
  assert.equal(Object.hasOwn(idleAdapter, 'doublecounted'), false)
  assert.deepEqual(Object.keys(idleAdapter).sort(), ['methodology', 'rsk'])
  assert.deepEqual(Object.keys(idleAdapter.rsk), ['tvl'])
  assert.deepEqual(Object.keys(adapter.rsk), ['tvl'])
  assert.notEqual(idleAdapter.rsk.tvl, adapter.rsk.tvl)

  // Each methodology names the other adapter. The legacy sentences are unchanged.
  assert.match(adapter.methodology, /Relaunch idle handlers are not counted here: the separate bitchill-idle adapter reports them\./)
  assert.match(adapter.methodology, /Legacy handlers: Tropykus values kToken balances with exchangeRateStored\. Sovryn values handler assets and attributes them to loanTokenAddress\./)
  assert.doesNotMatch(adapter.methodology, /idle handlers count/)
  assert.match(idleAdapter.methodology, /lending handlers are not counted here: the separate bitchill adapter reports them as double counted\./)
  assert.match(idleAdapter.methodology, /counted only from the start block of a verified deployment manifest/)
})

test('a relaunch reader needs an explicit category', () => {
  for (const manifest of [null, fixtureManifest()])
    for (const category of [undefined, 'all', 'Idle', 'layerbank', 0])
      assert.throws(() => createRelaunchTvl(manifest, category), /Unknown BitChill relaunch category/)
})

test('mixed totals: each handler is read by one adapter only, and the two adapters count each handler once', async () => {
  const block = START_BLOCK + 10
  const responses = { [block]: { ...LEGACY_RESPONSES, ...custodyResponses(SEVEN_PAIR_STATE) } }
  const manifest = fixtureManifest()

  const lendingApi = createLegacyApi(block, responses)
  await createLendingTvl(manifest)(lendingApi)
  const idleApi = createLegacyApi(block, responses)
  await createIdleTvl(manifest)(idleApi)

  // The custody read of a handler takes the handler as its argument. Map each such read to its pair.
  const pairsRead = api => api.calls
    .map(call => Object.keys(HANDLERS).find(pair => HANDLERS[pair].toLowerCase() === String(call.params?.[0]).toLowerCase()))
    .filter(Boolean)
  const idlePairs = pairsRead(idleApi)
  const lendingPairs = pairsRead(lendingApi)
  assert.deepEqual(idlePairs, IDLE_PAIRS)
  assert.deepEqual([...lendingPairs].sort(), [...LENDING_PAIRS].sort())
  assert.deepEqual([...idlePairs, ...lendingPairs].sort(), [...SUPPORTED_PAIRS].sort())

  // No read is made by both adapters, and the idle adapter makes no legacy read.
  const lendingKeys = new Set(lendingApi.calls.map(call => call.key))
  for (const call of idleApi.calls) assert.equal(lendingKeys.has(call.key), false)

  // One add per handler: three legacy and four relaunch lending adds, three relaunch idle adds.
  assert.equal(lendingApi.adds.length, 3 + LENDING_PAIRS.length)
  assert.equal(idleApi.adds.length, IDLE_PAIRS.length)

  // The sum of the two adapters is the legacy total plus one count of each relaunch handler.
  const combined = {}
  for (const balances of [lendingApi.balances, idleApi.balances])
    for (const [token, amount] of Object.entries(balances)) combined[token] = (combined[token] ?? 0n) + amount
  const relaunchOnce = sumByToken(SEVEN_PAIR_EXPECTED)
  assert.deepEqual(combined, {
    [DOC.toLowerCase()]: LEGACY_EXPECTED[DOC.toLowerCase()] + relaunchOnce[DOC.toLowerCase()],
    [USDRIF.toLowerCase()]: LEGACY_EXPECTED[USDRIF.toLowerCase()] + relaunchOnce[USDRIF.toLowerCase()],
    [USDT0.toLowerCase()]: relaunchOnce[USDT0.toLowerCase()],
  })

  // Hand-checked split: idle cash only in the idle adapter, lender positions only in the lending adapter.
  assert.deepEqual(idleApi.balances, {
    [DOC.toLowerCase()]: 1000000000000000000001n,
    [USDRIF.toLowerCase()]: 400000000000000000000n,
    [USDT0.toLowerCase()]: 2500000001n,
  })
  assert.deepEqual(lendingApi.balances, {
    [DOC.toLowerCase()]: 15309347739976302686n + 1454252674737243840448n + 2100000000000000000000n + 3703703670370370367000n,
    [USDRIF.toLowerCase()]: 16708418721585n + 10n,
    [USDT0.toLowerCase()]: 1000000000n,
  })
})

test('an idle-only manifest gives the lending adapter the legacy result alone', async () => {
  const manifest = subsetManifest(IDLE_PAIRS)
  const block = START_BLOCK + 10
  const responses = { [block]: { ...LEGACY_RESPONSES, ...custodyResponses(pick(SEVEN_PAIR_STATE, IDLE_PAIRS)) } }

  // No relaunch lending handler: the relaunch lending reader never uses the API.
  await createRelaunchTvl(manifest, 'lending')(untouchableApi())
  const lendingApi = createLegacyApi(block, responses)
  await createLendingTvl(manifest)(lendingApi)
  assert.deepEqual(lendingApi.balances, LEGACY_EXPECTED)
  assert.equal(lendingApi.calls.length, 6)
  assert.deepEqual(lendingApi.multiCalls, [])
  assert.equal(lendingApi.getBlockCalls, 0)

  const idleApi = createApi(block, responses)
  await createIdleTvl(manifest)(idleApi)
  assert.equal(idleApi.calls.length, IDLE_PAIRS.length)
  assert.deepEqual(idleApi.multiCalls.map(({ calls }) => calls), [assignmentCalls(IDLE_PAIRS)])
  assert.deepEqual(idleApi.balances, sumByToken(pick(SEVEN_PAIR_EXPECTED, IDLE_PAIRS)))
})

test('a lending-only manifest gives an idle adapter that never uses the API', async () => {
  const manifest = subsetManifest(LENDING_PAIRS)
  const block = START_BLOCK + 10
  const responses = { [block]: { ...LEGACY_RESPONSES, ...custodyResponses(pick(SEVEN_PAIR_STATE, LENDING_PAIRS)) } }

  await createIdleTvl(manifest)(untouchableApi())
  await createRelaunchTvl(manifest, 'idle')(untouchableApi())

  const lendingApi = createLegacyApi(block, responses)
  await createLendingTvl(manifest)(lendingApi)
  assert.equal(lendingApi.calls.length, 6 + CATEGORY_CALLS.lending)
  assert.deepEqual(lendingApi.multiCalls.map(({ calls }) => calls), [assignmentCalls(LENDING_PAIRS)])
  const lendingExpected = sumByToken(pick(SEVEN_PAIR_EXPECTED, LENDING_PAIRS))
  assert.deepEqual(lendingApi.balances, {
    [DOC.toLowerCase()]: LEGACY_EXPECTED[DOC.toLowerCase()] + lendingExpected[DOC.toLowerCase()],
    [USDRIF.toLowerCase()]: LEGACY_EXPECTED[USDRIF.toLowerCase()] + lendingExpected[USDRIF.toLowerCase()],
    [USDT0.toLowerCase()]: lendingExpected[USDT0.toLowerCase()],
  })
})

test('the DOC-only and six-pair launch subsets are split between the adapters with no Sovryn read', async t => {
  const subsets = [
    ['DOC-only', ['DOC:0', 'DOC:1'], { idle: { DOC: 1000000000000000000001n }, lending: { DOC: 2100000000000000000000n } }],
    ['six-pair', ['DOC:0', 'DOC:1', 'USDRIF:0', 'USDRIF:1', 'USDT0:0', 'USDT0:1'], {
      idle: { DOC: 1000000000000000000001n, USDRIF: 400000000000000000000n, USDT0: 2500000001n },
      lending: { DOC: 2100000000000000000000n, USDRIF: 10n, USDT0: 1000000000n },
    }],
  ]

  for (const [name, pairs, expected] of subsets) {
    await t.test(name, async () => {
      const manifest = subsetManifest(pairs)
      const block = START_BLOCK + 10
      const responses = { [block]: custodyResponses(pick(SEVEN_PAIR_STATE, pairs)) }

      const apis = { idle: createApi(block, responses), lending: createApi(block, responses) }
      await createIdleTvl(manifest)(apis.idle)
      await createRelaunchTvl(manifest, 'lending')(apis.lending)

      const byKey = amounts => Object.fromEntries(Object.entries(amounts).map(([symbol, amount]) => [TOKENS[symbol].address.toLowerCase(), amount]))
      for (const category of ['idle', 'lending']) {
        const api = apis[category]
        const categoryPairs = pairs.filter(pair => CATEGORY_PAIRS[category].includes(pair))
        // Idle: one read per handler. LayerBank: three reads per handler.
        assert.equal(api.calls.length, (category === 'idle' ? 1 : 3) * categoryPairs.length)
        assert.deepEqual(api.multiCalls.map(({ calls }) => calls), [assignmentCalls(pairs)])
        assert.equal(api.calls.some(call => call.target.toLowerCase() === TOKENS.DOC.sovrynIToken.toLowerCase()), false)
        assert.deepEqual(api.balances, byKey(expected[category]))
      }
    })
  }
})

test('historical blocks: before the start block the lending adapter is legacy only and the idle adapter reports nothing', async () => {
  const manifest = fixtureManifest()
  // Fixture values at each block. Only the block numbers are historical.
  for (const block of [9200000, 9294353, START_BLOCK - 1]) {
    const responses = { [block]: { ...LEGACY_RESPONSES, ...custodyResponses(SEVEN_PAIR_STATE) } }

    const lendingApi = createLegacyApi(block, responses)
    await createLendingTvl(manifest)(lendingApi)
    assert.deepEqual(lendingApi.balances, LEGACY_EXPECTED)
    assert.equal(lendingApi.calls.length, 6)
    for (const call of lendingApi.calls) assert.equal(call.block, block)
    assert.deepEqual(lendingApi.multiCalls, [])

    const idleApi = createLegacyApi(block, responses)
    await createIdleTvl(manifest)(idleApi)
    assert.deepEqual(idleApi.calls, [])
    assert.deepEqual(idleApi.multiCalls, [])
    assert.deepEqual(idleApi.balances, {})
  }
})
