import { describe, expect, it, vi } from 'vitest';
import { loadAddresses, lookupAddresses, normalizeStreet, parseAddress, selectAddressSide, type AddressIndex, type AddressHit } from '../src/lib/addresses';
import { searchStreets, type SideRecord } from '../src/lib/data';
const index: AddressIndex = { version: 1, streets: {
  '30TH AVE': [['534', -48970, 77904, 1642000], ['534A', -48971, 77905, 1642000], ['535', -48900, 77904, 1642000]],
  '30TH ST': [['534', -42000, 74000, 100]],
  '01ST ST': [['1', -40000, 78000, 101]],
} };
const sides: SideRecord[] = [
  { id: 1, cnn: '1642000', side: 'L', street: '30th Ave', limits: 'Geary Blvd - Anza St', blockside: 'West', mid: [-122.4895, 37.779], r: [] },
  { id: 2, cnn: '1642000', side: 'R', street: '30th Ave', limits: 'Geary Blvd - Anza St', blockside: 'East', mid: [-122.4894, 37.779], r: [] },
];
describe('address parsing', () => {
  it.each(['534 30th Ave', '534 30th avenue', '534 30TH AVE.', '534 thirtieth avenue', '534 30 avenue', '534 30th Ave #2', '534 30th Ave Apt 3', '534 30th Ave Apartment 3', '534 30th Ave Unit 3', '534 30th Ave, San Francisco, CA'])('normalizes %s', q => {
    expect(parseAddress(q)).toEqual({ house: '534', street: '30 ave' });
    expect(lookupAddresses(index, q)[0].label).toBe('534 30TH AVE');
  });
  it('preserves house letter suffixes and ignores units', () => {
    expect(lookupAddresses(index, '534a 30th Avenue #2')[0].label).toBe('534A 30TH AVE');
    expect(lookupAddresses(index, '534 A 30th Ave Apt 3')[0].baseFallback).toBe(false);
    expect(lookupAddresses(index, '534B 30th Ave')[0]).toMatchObject({ label: '534 30TH AVE', baseFallback: true });
  });
  it.each(['30th ave', '30TH AVENUE', 'Market St', '', '534'])('does not treat %s as an address', q => expect(parseAddress(q)).toBeNull());
  it('normalizes zero-padded ordinals and compound word ordinals', () => {
    expect(normalizeStreet('01ST STREET')).toBe('1 st');
    expect(normalizeStreet('Twenty-First Avenue')).toBe('21 ave');
    expect(lookupAddresses(index, '1 first street')[0].label).toBe('1 01ST ST');
  });
});
describe('address lookup', () => {
  it('does not confuse streets and avenues or invent missing house numbers', () => {
    expect(lookupAddresses(index, '534 30th street')[0].cnn).toBe('100');
    expect(lookupAddresses(index, '99999 30th ave')).toEqual([]);
    expect(lookupAddresses(index, '534 Market St')).toEqual([]);
    expect(lookupAddresses(index, '534 30th', 1)).toHaveLength(1);
  });
  it('decodes coordinates and retains CNN', () => expect(lookupAddresses(index, '534 30th ave')[0]).toMatchObject({ point: [-122.4897, 37.77904], cnn: '1642000' }));
  it('keeps existing street-only search', () => expect(searchStreets(sides, '30th ave')).toHaveLength(1));
});
describe('sweeping segment selection', () => {
  const hit = lookupAddresses(index, '534 30th ave')[0];
  it('selects the address CNN and its closest offset side', () => {
    expect(selectAddressSide(sides, hit)?.id).toBe(1);
    expect(selectAddressSide(sides, { ...hit, point: [-122.4891, 37.779] })?.id).toBe(2);
  });
  it('never guesses another block or cross street', () => {
    const wrong = { ...sides[0], id: 3, cnn: '999', mid: hit.point };
    expect(selectAddressSide([wrong, ...sides], hit)?.id).toBe(1);
    expect(selectAddressSide(sides, { ...hit, cnn: '999' })).toBeUndefined();
    expect(selectAddressSide(sides, { ...hit, street: '30TH ST' })).toBeUndefined();
  });
  it('handles one-sided coverage and ties deterministically', () => {
    expect(selectAddressSide([sides[1]], hit)?.id).toBe(2);
    expect(selectAddressSide([{ ...sides[1], mid: sides[0].mid }, sides[0]], hit)?.id).toBe(1);
  });
  it('normalizes EAS/sweep street spellings', () => expect(selectAddressSide(sides, { ...hit, street: 'Thirtieth Avenue' } as AddressHit)?.id).toBe(1));
});
it('lazy load reports failure and allows retry (no permanently cached rejection)', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, json: async () => index });
  vi.stubGlobal('fetch', fetchMock);
  await expect(loadAddresses()).rejects.toThrow('unavailable');
  await expect(loadAddresses()).resolves.toBe(index);
  await loadAddresses();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});
