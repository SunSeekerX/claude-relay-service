import { jest } from '@jest/globals'
const calculateCost = jest.fn(() => ({ costs: { input: 2, output: 1, total: 3 } }))
jest.unstable_mockModule('../src/modules/pricing/pricing_cost_calculator.js', () => ({
  CostCalculator: { calculateCost }
}))
const { createUsageRecordCostResolver } =
  await import('../src/modules/pricing/pricing_usage_record_cost.js')

beforeEach(() => jest.clearAllMocks())

it('keeps stored zero charges and exact official cost without recomputing', () => {
  const resolve = createUsageRecordCostResolver()
  const record = {
    model: 'grok-test',
    cost: 0,
    realCost: 1e-10,
    costBreakdown: { input: 2, total: 2 },
    realCostBreakdown: { total: 1e-10 }
  }
  expect(resolve(record, {}, 'default')).toEqual({ cost: 0 })
  expect(resolve(record, {}, 'default', true)).toMatchObject({
    cost: 0,
    realCost: 1e-10,
    costBreakdown: { total: 2 },
    realCostBreakdown: { total: 1e-10 }
  })
  expect(calculateCost).not.toHaveBeenCalled()
})

it('recomputes a legacy missing amount once per query using its actual tier', () => {
  const resolve = createUsageRecordCostResolver()
  const record = { model: 'gpt-test' }
  const usage = { input_tokens: 100, output_tokens: 20 }
  expect(resolve(record, usage, 'priority')).toEqual({ cost: 3 })
  expect(resolve(record, usage, 'priority', true)).toMatchObject({ cost: 3, realCost: 3 })
  expect(calculateCost).toHaveBeenCalledTimes(1)
  expect(calculateCost).toHaveBeenCalledWith(usage, 'gpt-test', 'priority')
})

it('does not recompute missing breakdowns until they are needed for a displayed page', () => {
  const resolve = createUsageRecordCostResolver()
  const record = { model: 'gpt-test', cost: 5, realCost: 2 }
  expect(resolve(record, {}, null)).toEqual({ cost: 5 })
  expect(calculateCost).not.toHaveBeenCalled()
  expect(resolve(record, {}, null, true)).toMatchObject({ cost: 5, realCost: 2 })
  expect(calculateCost).toHaveBeenCalledTimes(1)
})
