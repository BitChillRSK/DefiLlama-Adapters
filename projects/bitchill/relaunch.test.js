const assert = require('node:assert/strict')
const test = require('node:test')

const adapter = require('./index')
const { legacyTvl, LEGACY_ADDRESSES } = require('./legacy')
const {
  RELAUNCH_MANIFEST,
  SUPPORTED_PAIRS,
  TOKENS,
  validateRelaunchManifest,
  createRelaunchTvl,
} = require('./relaunch')

// Fixture addresses only. None of them is a deployed BitChill relaunch contract.
const fixtureAddress = suffix => `0x${'f1'.repeat(18)}${suffix.toString(16).padStart(4, '0')}`
const DCA_MANAGER = fixtureAddress(0x0001)
const OPERATIONS_ADMIN = fixtureAddress(0x0002)
const POOL = fixtureAddress(0x00aa)
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
  const signature = /^function \w+\(([^)]*)\) view returns \(uint256\)$/.exec(abi)
  assert.ok(signature, `unsupported ABI: ${abi}`)
  assert.equal(params.length, signature[1].split(',').filter(Boolean).length)
}

// Fake block-scoped ChainApi. Fixtures are stored per block, so a read at another block fails.
function createApi(block, responsesByBlock, { lazyBlock = false } = {}) {
  const api = {
    block: lazyBlock ? undefined : block,
    calls: [],
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
    add(token, amount) {
      assert.equal(typeof amount, 'bigint')
      const key = token.toLowerCase()
      this.adds.push({ token: key, amount })
      this.balances[key] = (this.balances[key] ?? 0n) + amount
    },
  }
  return api
}

// Builds the lender and token responses for a custody state.
// state: { 'DOC:0': cash, 'DOC:1': { scaled, index }, 'DOC:2': { shares, price }, ... }
function custodyResponses(state) {
  const responses = {}
  for (const [pair, value] of Object.entries(state)) {
    const [symbol, routeIndex] = pair.split(':')
    const token = TOKENS[symbol]
    const handler = HANDLERS[pair]
    if (routeIndex === '0') {
      responses[callKey({ target: token.address, abi: ABI_BALANCE_OF, params: [handler] })] = value
    } else if (routeIndex === '1') {
      responses[callKey({ target: token.layerBankAToken, abi: ABI_SCALED_BALANCE_OF, params: [handler] })] = value.scaled
      responses[callKey({ target: token.layerBankAToken, abi: ABI_POOL })] = POOL
      responses[callKey({ target: POOL, abi: ABI_NORMALIZED_INCOME, params: [token.address] })] = value.index
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
  const untouchable = new Proxy({}, {
    get(_, property) {
      if (property === 'then') return undefined
      throw new Error(`relaunch reader used api.${String(property)} without a manifest`)
    },
  })

  await createRelaunchTvl(null)(untouchable)
  await createRelaunchTvl(undefined)(untouchable)
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
  const api = createApi(block, { [block]: custodyResponses(SEVEN_PAIR_STATE) })

  await createRelaunchTvl(fixtureManifest())(api)

  // One add per handler, in manifest order, each with the handler's own stablecoin.
  assert.deepEqual(api.adds, SUPPORTED_PAIRS.map(pair => ({
    token: TOKENS[pair.split(':')[0]].address.toLowerCase(),
    amount: SEVEN_PAIR_EXPECTED[pair],
  })))

  // Hand-checked values: integer floors, 18 decimals and 6 decimals.
  assert.equal(SEVEN_PAIR_EXPECTED['DOC:1'], 2100000000000000000000n)
  assert.equal(SEVEN_PAIR_EXPECTED['DOC:2'], 3703703670370370367000n)
  assert.equal(SEVEN_PAIR_EXPECTED['USDRIF:1'], 10n)
  assert.equal(SEVEN_PAIR_EXPECTED['USDT0:1'], 1000000000n) // 1000000000.999999998 floors

  // Exact token keys: the three stablecoins and nothing else.
  assert.deepEqual(api.balances, {
    [DOC.toLowerCase()]: 1000000000000000000001n + 2100000000000000000000n + 3703703670370370367000n,
    [USDRIF.toLowerCase()]: 400000000000000000010n,
    [USDT0.toLowerCase()]: 2500000001n + 1000000000n,
  })
  for (const token of Object.values(TOKENS)) {
    assert.equal(api.balances[token.layerBankAToken.toLowerCase()], undefined)
    if (token.sovrynIToken) assert.equal(api.balances[token.sovrynIToken.toLowerCase()], undefined)
  }
})

test('makes exactly the expected reads and every read uses the supplied block', async () => {
  const block = START_BLOCK + 10
  const responses = custodyResponses(SEVEN_PAIR_STATE)
  const api = createApi(block, { [block]: responses })

  await createRelaunchTvl(fixtureManifest())(api)

  // idle: 1 read. LayerBank: 3 reads. Sovryn: 2 reads. 3 + 9 + 2 = 14.
  assert.equal(api.calls.length, 14)
  assert.deepEqual(new Set(api.calls.map(call => call.key)), new Set([
    ...Object.keys(responses).filter(key => !key.includes('|address:POOL|')),
    callKey({ target: TOKENS.DOC.layerBankAToken, abi: ABI_POOL }),
    callKey({ target: TOKENS.USDRIF.layerBankAToken, abi: ABI_POOL }),
    callKey({ target: TOKENS.USDT0.layerBankAToken, abi: ABI_POOL }),
  ]))
  for (const call of api.calls) assert.equal(call.block, block)
  assert.equal(api.getBlockCalls, 0)

  // No handler, DcaManager or OperationsAdmin is a call target: custody is read from tokens and lenders.
  const targets = new Set(api.calls.map(call => call.target.toLowerCase()))
  for (const address of [...Object.values(HANDLERS), DCA_MANAGER, OPERATIONS_ADMIN])
    assert.equal(targets.has(address.toLowerCase()), false)
})

test('a read at a block without a fixture fails instead of using another block', async () => {
  const fixtureBlock = START_BLOCK + 10
  const api = createApi(START_BLOCK + 11, { [fixtureBlock]: custodyResponses(SEVEN_PAIR_STATE) })

  await assert.rejects(createRelaunchTvl(fixtureManifest())(api), /unexpected call at block 9500011/)
  assert.deepEqual(api.adds, [])
})

test('empty handlers add zero for each stablecoin', async () => {
  const block = START_BLOCK
  const api = createApi(block, {
    [block]: custodyResponses({
      'DOC:0': '0',
      'DOC:1': { scaled: '0', index: '1050000000000000000000000001' },
      'DOC:2': { shares: '0', price: '1234567890123456789' },
      'USDRIF:0': '0',
      'USDRIF:1': { scaled: '0', index: '1500000000000000000000000001' },
      'USDT0:0': '0',
      'USDT0:1': { scaled: '0', index: '1000000002000000000000000000' },
    }),
  })

  await createRelaunchTvl(fixtureManifest())(api)

  assert.equal(api.adds.length, 7)
  assert.deepEqual(api.balances, {
    [DOC.toLowerCase()]: 0n,
    [USDRIF.toLowerCase()]: 0n,
    [USDT0.toLowerCase()]: 0n,
  })
})

test('skips every relaunch read before the deployment start block and reads from it', async () => {
  const relaunchTvl = createRelaunchTvl(fixtureManifest())
  const responses = custodyResponses(SEVEN_PAIR_STATE)

  for (const block of [9200000, 9294353, START_BLOCK - 1]) {
    const before = createApi(block, { [block]: responses })
    await relaunchTvl(before)
    assert.deepEqual(before.calls, [])
    assert.deepEqual(before.adds, [])
    assert.deepEqual(before.balances, {})
  }

  const atStart = createApi(START_BLOCK, { [START_BLOCK]: responses })
  await relaunchTvl(atStart)
  assert.equal(atStart.calls.length, 14)
  assert.deepEqual(atStart.balances, sumByToken(SEVEN_PAIR_EXPECTED))
})

test('resolves an unset block through the supplied API only', async () => {
  const relaunchTvl = createRelaunchTvl(fixtureManifest())
  const responses = custodyResponses(SEVEN_PAIR_STATE)

  const early = createApi(START_BLOCK - 1, { [START_BLOCK - 1]: responses }, { lazyBlock: true })
  await relaunchTvl(early)
  assert.equal(early.getBlockCalls, 1)
  assert.deepEqual(early.calls, [])

  const late = createApi(START_BLOCK + 5, { [START_BLOCK + 5]: responses }, { lazyBlock: true })
  await relaunchTvl(late)
  assert.equal(late.getBlockCalls, 1)
  assert.equal(late.calls.length, 14)
  for (const call of late.calls) assert.equal(call.block, START_BLOCK + 5)

  const noBlock = { block: undefined, getBlock: async () => undefined, call: async () => assert.fail('no read expected'), add: () => assert.fail('no add expected') }
  await assert.rejects(relaunchTvl(noBlock), /needs a block number/)
})

test('accepts the fixture manifest and returns the seven handlers with their routes', () => {
  const deployment = validateRelaunchManifest(fixtureManifest())

  assert.equal(deployment.startBlock, START_BLOCK)
  assert.equal(deployment.protocolVersion, 'fixture-2')
  assert.equal(deployment.dcaManager, DCA_MANAGER)
  assert.equal(deployment.operationsAdmin, OPERATIONS_ADMIN)
  assert.deepEqual(deployment.handlers.map(({ pair, protocol, handler, stablecoin, decimals }) => ({ pair, protocol, handler, stablecoin, decimals })), [
    { pair: 'DOC:0', protocol: 'idle', handler: HANDLERS['DOC:0'], stablecoin: DOC, decimals: 18 },
    { pair: 'DOC:1', protocol: 'layerbank', handler: HANDLERS['DOC:1'], stablecoin: DOC, decimals: 18 },
    { pair: 'DOC:2', protocol: 'sovryn', handler: HANDLERS['DOC:2'], stablecoin: DOC, decimals: 18 },
    { pair: 'USDRIF:0', protocol: 'idle', handler: HANDLERS['USDRIF:0'], stablecoin: USDRIF, decimals: 18 },
    { pair: 'USDRIF:1', protocol: 'layerbank', handler: HANDLERS['USDRIF:1'], stablecoin: USDRIF, decimals: 18 },
    { pair: 'USDT0:0', protocol: 'idle', handler: HANDLERS['USDT0:0'], stablecoin: USDT0, decimals: 6 },
    { pair: 'USDT0:1', protocol: 'layerbank', handler: HANDLERS['USDT0:1'], stablecoin: USDT0, decimals: 6 },
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
      // The reader cannot be built from a defective manifest, so it cannot report a partial TVL.
      assert.throws(() => createRelaunchTvl(manifest), /Invalid BitChill relaunch manifest/)
    })
  }
})

test('reads only the handlers of an explicit active subset', async () => {
  const activePairs = ['DOC:0', 'USDT0:1']
  const manifest = fixtureManifest({
    activePairs,
    handlers: fixtureManifest().handlers.filter(({ token, routeIndex }) => activePairs.includes(`${token}:${routeIndex}`)),
  })
  const block = START_BLOCK + 1
  const api = createApi(block, {
    [block]: custodyResponses({ 'DOC:0': SEVEN_PAIR_STATE['DOC:0'], 'USDT0:1': SEVEN_PAIR_STATE['USDT0:1'] }),
  })

  await createRelaunchTvl(manifest)(api)

  assert.equal(api.calls.length, 4)
  assert.deepEqual(api.balances, {
    [DOC.toLowerCase()]: SEVEN_PAIR_EXPECTED['DOC:0'],
    [USDT0.toLowerCase()]: SEVEN_PAIR_EXPECTED['USDT0:1'],
  })
})

test('a stablecoin spent in a purchase is not counted again as rBTC', async () => {
  // DOC idle and USDT0 LayerBank handlers through purchase, claim and withdrawal.
  // The rbtc fields describe the handler state. The adapter must never read them.
  const index = '1100000000000000000000000000'
  const idleOthers = { 'DOC:1': { scaled: '0', index }, 'DOC:2': { shares: '0', price: '1000000000000000000' }, 'USDRIF:0': '0', 'USDRIF:1': { scaled: '0', index }, 'USDT0:0': '0' }
  const states = [
    {
      name: 'before purchase',
      block: START_BLOCK + 100,
      custody: { 'DOC:0': '1000000000000000000000', 'USDT0:1': { scaled: '2000000000', index } },
      rbtc: { handlerNativeBalance: 0n, userClaims: 0n },
      expected: { doc: 1000000000000000000000n, usdt0: 2200000000n },
    },
    {
      name: 'after purchase, rBTC waits on the handlers',
      block: START_BLOCK + 200,
      // 250 DOC and 550 USDT0 (500000000 scaled shares) were sold for rBTC.
      custody: { 'DOC:0': '750000000000000000000', 'USDT0:1': { scaled: '1500000000', index } },
      rbtc: { handlerNativeBalance: 12500000000000000n, userClaims: 12500000000000000n },
      expected: { doc: 750000000000000000000n, usdt0: 1650000000n },
    },
    {
      name: 'after the users withdraw their rBTC',
      block: START_BLOCK + 300,
      custody: { 'DOC:0': '750000000000000000000', 'USDT0:1': { scaled: '1500000000', index } },
      rbtc: { handlerNativeBalance: 0n, userClaims: 0n },
      expected: { doc: 750000000000000000000n, usdt0: 1650000000n },
    },
  ]

  const relaunchTvl = createRelaunchTvl(fixtureManifest())
  const results = []
  for (const state of states) {
    const api = createApi(state.block, { [state.block]: custodyResponses({ ...idleOthers, ...state.custody }) })
    await relaunchTvl(api)

    // Only stablecoin keys exist: no native rBTC, no WRBTC, no other asset.
    assert.deepEqual(api.balances, {
      [DOC.toLowerCase()]: state.expected.doc,
      [USDRIF.toLowerCase()]: 0n,
      [USDT0.toLowerCase()]: state.expected.usdt0,
    }, state.name)
    assert.equal(api.balances[ZERO_ADDRESS], undefined)
    assert.equal(api.balances[WRBTC.toLowerCase()], undefined)

    // No read asks a handler for its rBTC: every call is a token or lender view with a known ABI.
    for (const call of api.calls) {
      assert.ok([ABI_BALANCE_OF, ABI_SCALED_BALANCE_OF, ABI_POOL, ABI_NORMALIZED_INCOME, ABI_TOKEN_PRICE].includes(call.abi))
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
})

test('legacy and relaunch totals stay separate and add up on one API', async () => {
  const block = START_BLOCK + 10
  const relaunchResponses = custodyResponses(SEVEN_PAIR_STATE)
  const relaunchTvl = createRelaunchTvl(fixtureManifest())

  const legacyApi = createLegacyApi(block, { [block]: LEGACY_RESPONSES })
  await legacyTvl(legacyApi)
  assert.deepEqual(legacyApi.balances, LEGACY_EXPECTED)

  const relaunchApi = createApi(block, { [block]: relaunchResponses })
  await relaunchTvl(relaunchApi)
  assert.deepEqual(relaunchApi.balances, sumByToken(SEVEN_PAIR_EXPECTED))

  // No call is shared: each reader makes only its own reads.
  const legacyKeys = new Set(legacyApi.calls.map(call => call.key))
  for (const call of relaunchApi.calls) assert.equal(legacyKeys.has(call.key), false)

  const bothApi = createLegacyApi(block, { [block]: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await legacyTvl(bothApi)
  await relaunchTvl(bothApi)
  assert.equal(bothApi.calls.length, 20)
  assert.deepEqual(bothApi.balances, {
    [DOC.toLowerCase()]: LEGACY_EXPECTED[DOC.toLowerCase()] + sumByToken(SEVEN_PAIR_EXPECTED)[DOC.toLowerCase()],
    [USDRIF.toLowerCase()]: LEGACY_EXPECTED[USDRIF.toLowerCase()] + sumByToken(SEVEN_PAIR_EXPECTED)[USDRIF.toLowerCase()],
    [USDT0.toLowerCase()]: sumByToken(SEVEN_PAIR_EXPECTED)[USDT0.toLowerCase()],
  })

  // Before the start block the same composition gives the legacy result only.
  const earlyApi = createLegacyApi(9294353, { 9294353: { ...LEGACY_RESPONSES, ...relaunchResponses } })
  await legacyTvl(earlyApi)
  await relaunchTvl(earlyApi)
  assert.deepEqual(earlyApi.balances, LEGACY_EXPECTED)
  assert.equal(earlyApi.calls.length, 6)
})
