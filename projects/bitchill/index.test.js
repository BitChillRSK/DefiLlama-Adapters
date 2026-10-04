const assert = require('node:assert/strict')
const test = require('node:test')

const adapter = require('./index')

const K_DOC = '0x544Eb90e766B405134b3B3F62b6b4C23Fcd5fDa2'
const K_USDRIF = '0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C'
const I_SUSD = '0xd8D25f03EBbA94E15Df2eD4d6D38276B595593c1'
const DOC_HANDLER = '0xb60024d0030d7876f02BB766E18F0664e81B0856'
const SOVRYN_HANDLER = '0xA1A752784d4d43778ED23771777B18AE9cb66461'
const USDRIF_HANDLER = '0xAfcD7A6F5165F09b049ded06EEC12F5A9E3D09A2'
const DOC = '0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db'
const USDRIF = '0x3A15461d8aE0F0Fb5Fa2629e9DA7D66A794a6e37'

function callKey({ target, abi, params = [] }) {
  return `${target.toLowerCase()}|${abi}|${params.join(',').toLowerCase()}`
}

function validateAssetBalanceOfAbi(abi, params) {
  const completeSignature = /^function assetBalanceOf\(([^)]*)\) view returns \(uint256\)$/.exec(abi)
  if (!completeSignature) {
    if (abi === 'uint256:assetBalanceOf' && params.length > 0)
      throw new TypeError('assetBalanceOf shorthand declares zero ABI inputs')
    throw new TypeError(`unsupported assetBalanceOf ABI: ${abi}`)
  }

  const inputTypes = completeSignature[1].split(',').filter(Boolean)
  assert.deepEqual(inputTypes, ['address'])
  assert.equal(params.length, inputTypes.length)
  assert.match(params[0], /^0x[\da-f]{40}$/i)
}

function createApi(block, responses) {
  const calls = []
  const balances = {}
  return {
    block,
    calls,
    balances,
    async call(request) {
      calls.push({ block: this.block, ...request })
      const response = responses[callKey(request)]
      assert.notEqual(response, undefined, `unexpected call: ${callKey(request)}`)
      return response
    },
    add(token, amount) {
      const key = token.toLowerCase()
      balances[key] = (balances[key] ?? 0n) + BigInt(amount)
    },
  }
}

function responses({ kDocBalance, kDocRate, kUsdrifBalance, kUsdrifRate, sovrynToken, sovrynBalance }) {
  return {
    [callKey({ target: K_DOC, abi: 'erc20:balanceOf', params: [DOC_HANDLER] })]: kDocBalance,
    [callKey({ target: K_DOC, abi: 'uint256:exchangeRateStored' })]: kDocRate,
    [callKey({ target: K_USDRIF, abi: 'erc20:balanceOf', params: [USDRIF_HANDLER] })]: kUsdrifBalance,
    [callKey({ target: K_USDRIF, abi: 'uint256:exchangeRateStored' })]: kUsdrifRate,
    [callKey({ target: I_SUSD, abi: 'address:loanTokenAddress' })]: sovrynToken,
    [callKey({ target: I_SUSD, abi: 'function assetBalanceOf(address) view returns (uint256)', params: [SOVRYN_HANDLER] })]: sovrynBalance,
  }
}

test('requires the Sovryn handler in the assetBalanceOf ABI', () => {
  const zeroInputShorthand = 'uint256:assetBalanceOf'
  const completeSignature = 'function assetBalanceOf(address) view returns (uint256)'

  assert.throws(() => validateAssetBalanceOfAbi(zeroInputShorthand, [SOVRYN_HANDLER]), /zero ABI inputs/)
  assert.doesNotThrow(() => validateAssetBalanceOfAbi(completeSignature, [SOVRYN_HANDLER]))
})

test('calculates both Tropykus underlying balances with integer floors', async () => {
  const api = createApi(9200000, responses({
    kDocBalance: 7n,
    kDocRate: 1500000000000000001n,
    kUsdrifBalance: 3n,
    kUsdrifRate: 2345678901234567890n,
    sovrynToken: '0x0000000000000000000000000000000000000065',
    sovrynBalance: 20n,
  }))

  await adapter.rsk.tvl(api)

  assert.equal(api.balances[DOC.toLowerCase()], 10n)
  assert.equal(api.balances[USDRIF.toLowerCase()], 7n)
})

test('uses the returned Sovryn asset and excludes receipt tokens', async () => {
  const sovrynToken = '0x0000000000000000000000000000000000000065'
  const api = createApi(9294353, responses({
    kDocBalance: 100n,
    kDocRate: 1000000000000000000n,
    kUsdrifBalance: 200n,
    kUsdrifRate: 1000000000000000000n,
    sovrynToken,
    sovrynBalance: 300n,
  }))

  await adapter.rsk.tvl(api)

  assert.equal(api.balances[sovrynToken], 300n)
  assert.deepEqual(Object.keys(api.balances).sort(), [DOC, USDRIF, sovrynToken].map(token => token.toLowerCase()).sort())
  assert.equal(api.balances[K_DOC.toLowerCase()], undefined)
  assert.equal(api.balances[K_USDRIF.toLowerCase()], undefined)
  assert.equal(api.balances[I_SUSD.toLowerCase()], undefined)
})

test('keeps zero balances and every read on the supplied block-scoped API', async () => {
  const api = createApi(9294353, responses({
    kDocBalance: 0n,
    kDocRate: 2000000000000000000n,
    kUsdrifBalance: 0n,
    kUsdrifRate: 3000000000000000000n,
    sovrynToken: DOC,
    sovrynBalance: 0n,
  }))

  await adapter.rsk.tvl(api)

  assert.equal(api.balances[DOC.toLowerCase()], 0n)
  assert.equal(api.balances[USDRIF.toLowerCase()], 0n)
  assert.equal(api.calls.length, 6)
  assert.deepEqual(new Set(api.calls.map(call => call.block)), new Set([9294353]))
  assert.deepEqual(new Set(api.calls.map(call => call.target.toLowerCase())), new Set([K_DOC, K_USDRIF, I_SUSD].map(token => token.toLowerCase())))
})
