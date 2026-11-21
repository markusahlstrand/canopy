import { describe, expect, it } from 'vitest';
import { nameKey, normalizeValue, PREDICATES, predicateById } from '../spec/model.js';

describe('vocabulary', () => {
  it('has unique predicate ids, each with a domain and a range', () => {
    expect(new Set(PREDICATES.map((p) => p.id)).size).toBe(PREDICATES.length);
    for (const p of PREDICATES) expect(p.domain.length).toBeGreaterThan(0);
    expect(predicateById('vatID')?.matchKey).toBe(true);
    expect(predicateById('nope')).toBeUndefined();
  });
});

describe('normalizeValue', () => {
  it('normalises contact values', () => {
    expect(normalizeValue('email', ' Ana@Example.COM ')?.value).toBe('ana@example.com');
    expect(normalizeValue('email', 'not an email')).toBeNull();
    expect(normalizeValue('telephone', '0034 (91) 123-45-67')?.value).toBe('+34911234567');
    expect(normalizeValue('url', 'https://www.Acme.es/')?.value).toBe('acme.es');
    expect(normalizeValue('url', 'javascript:alert(1)')).toBeNull();
  });

  it('checks dates and money', () => {
    expect(normalizeValue('date', '2026-02-29')).toBeNull();
    expect(normalizeValue('date', '2028-02-29')?.value).toBe('2028-02-29');
    expect(normalizeValue('money', '1234,5 eur')?.value).toBe('1234.50 EUR');
    expect(normalizeValue('money', '12 euros')).toBeNull();
  });

  it('checks IBAN and VAT numbers', () => {
    expect(normalizeValue('iban', 'ES91 2100 0418 4502 0005 1332')?.value).toBe('ES9121000418450200051332');
    expect(normalizeValue('iban', 'ES91 2100 0418 4502 0005 1333')).toBeNull();
    expect(normalizeValue('vatID', 'es b-12345678')?.value).toBe('ESB12345678');
    expect(normalizeValue('vatID', 'ZZ123')).toBeNull();
  });

  it('checks Spanish NIF, NIE and CIF', () => {
    expect(normalizeValue('es:nif', '12345678-Z')?.value).toBe('12345678Z');
    expect(normalizeValue('es:nif', '12345678A')).toBeNull();
    expect(normalizeValue('es:nif', 'X1234567L')?.value).toBe('X1234567L');
    expect(normalizeValue('es:nif', 'B58818501')?.value).toBe('B58818501');
    expect(normalizeValue('es:nif', 'B58818502')).toBeNull();
  });

  it('checks Swedish numbers and masks a personnummer', () => {
    expect(normalizeValue('se:orgnr', '556036-0793')?.value).toBe('556036-0793');
    expect(normalizeValue('se:orgnr', 'SE556036079301')?.value).toBe('556036-0793');
    expect(normalizeValue('se:orgnr', '556036-0794')).toBeNull();
    const pn = normalizeValue('se:personnummer', '19811218-9876');
    expect(pn).toEqual({ value: '811218-9876', display: '811218-****' });
    expect(normalizeValue('se:personnummer', '811218-9875')).toBeNull();
  });
});

describe('nameKey', () => {
  it('ignores case, accents, punctuation and legal form', () => {
    expect(nameKey('Organization', 'Acme, S.L.')).toBe(nameKey('Organization', 'ACME SL'));
    expect(nameKey('Organization', 'Gestoría López S.L.U.')).toBe('gestoria lopez');
    expect(nameKey('Person', 'José  Núñez')).toBe('jose nunez');
  });
});
