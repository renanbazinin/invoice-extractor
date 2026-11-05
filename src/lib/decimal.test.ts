import { describe, expect, it } from 'vitest'
import { add, canonical, dec, div, mul, near, round, sameDecimal, str, sub, sum } from './decimal'

describe('decimal', () => {
  it('adds and subtracts exactly across scales', () => {
    expect(str(add(dec('0.1'), dec('0.2')))).toBe('0.3')
    expect(str(sub(dec('1180'), dec('500.00')))).toBe('680.00')
    expect(str(sum([dec('19.99'), dec('0.01'), dec('-5')]))).toBe('15.00')
  })

  it('multiplies and rounds half away from zero', () => {
    expect(str(round(mul(dec('1000'), dec('0.17')), 2))).toBe('170.00')
    expect(str(round(dec('2.345'), 2))).toBe('2.35')
    expect(str(round(dec('-2.345'), 2))).toBe('-2.35')
    expect(str(round(dec('2.344'), 2))).toBe('2.34')
  })

  it('divides to a scale', () => {
    expect(str(div(dec('180'), dec('1000'), 4))).toBe('0.1800')
    expect(str(div(dec('10'), dec('3'), 2))).toBe('3.33')
  })

  it('compares with tolerance and canonicalises', () => {
    expect(near(dec('100.01'), dec('100'), dec('0.01'))).toBe(true)
    expect(near(dec('100.02'), dec('100'), dec('0.01'))).toBe(false)
    expect(canonical('18.00')).toBe('18')
    expect(canonical('1180.50')).toBe('1180.5')
    expect(canonical('-0.0')).toBe('0')
    expect(sameDecimal('18', '18.000')).toBe(true)
  })

  it('rejects printed formats', () => {
    expect(() => dec('1,180.00')).toThrow()
    expect(() => dec('₪5')).toThrow()
  })
})
