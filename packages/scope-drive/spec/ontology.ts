/**
 * The default vocabulary of a space's knowledge graph: which things a document can be about,
 * and which statements can be made about them.
 *
 * Adopted, not invented: the names are schema.org's (`Person`, `Organization`, `Place`,
 * `email`, `vatID`, `worksFor`, the `Invoice` properties `provider` / `customer` /
 * `totalPaymentDue` / `paymentDueDate`), with two locale packs for the identifiers schema.org
 * leaves generic — Spain's NIF/NIE/CIF and Sweden's organisationsnummer and personnummer.
 *
 * It is CLOSED. The model may only use predicates listed here; anything else it answers is
 * dropped, never added. A vocabulary that grows one document at a time is the sprawl that sank
 * the last attempt at this (`documentation/design-relationship-intelligence.md`).
 *
 * Values are not nodes. An email, a phone number or a VAT id is a typed literal with a
 * normaliser, and the normalised form is what makes two documents agree: the same VAT id is the
 * same company. Predicates marked `matchKey` are the ones identity resolution trusts.
 *
 * Everything here is pure and synchronous, so the scope (which stores and matches) and the
 * worker (which asks the model) read the same rules.
 */

export const ENTITY_TYPES = ['Person', 'Organization', 'Place'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
/** What a statement can be about: one of the entity types, or the document it was read from. */
export type SubjectType = EntityType | 'Document';

export const VALUE_KINDS = [
  'text', 'email', 'telephone', 'url', 'date', 'money', 'iban', 'vatID', 'es:nif', 'se:orgnr', 'se:personnummer',
] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const VOCABULARY_PACKS = ['core', 'invoice', 'es', 'se'] as const;
export type VocabularyPack = (typeof VOCABULARY_PACKS)[number];

export interface PredicateDef {
  id: string;
  /** How the review UI says it: "<subject> <label> <object>". */
  label: string;
  pack: VocabularyPack;
  domain: readonly SubjectType[];
  range: { entity: readonly EntityType[] } | { value: ValueKind };
  /** One current value (an address) or many at once (phone numbers). */
  cardinality: 'single' | 'multi';
  /**
   * How a second, different value is read: `immutable` — it is an error (a VAT id does not
   * change); `interval` — it may be a change (people move); `point` — true at one moment.
   */
  temporality: 'immutable' | 'interval' | 'point';
  /** Identity resolution trusts it: two entities with the same value are the same entity. */
  matchKey?: true;
  /** Personal data a list masks until asked: the strongest match keys are also the riskiest. */
  sensitive?: true;
  /** For the model: when to use it. */
  hint: string;
}

const PARTY = ['Person', 'Organization'] as const;

export const PREDICATES: readonly PredicateDef[] = [
  // core — schema.org Person / Organization / Place
  { id: 'email', label: 'has email', pack: 'core', domain: PARTY, range: { value: 'email' }, cardinality: 'multi', temporality: 'interval', matchKey: true, hint: 'an email address of the person or organisation' },
  { id: 'telephone', label: 'has phone', pack: 'core', domain: PARTY, range: { value: 'telephone' }, cardinality: 'multi', temporality: 'interval', hint: 'a phone number, with country code when shown' },
  { id: 'url', label: 'has website', pack: 'core', domain: PARTY, range: { value: 'url' }, cardinality: 'multi', temporality: 'interval', hint: 'a website' },
  { id: 'address', label: 'is located at', pack: 'core', domain: ['Person', 'Organization', 'Place'], range: { value: 'text' }, cardinality: 'single', temporality: 'interval', hint: 'a postal address, as one line' },
  { id: 'vatID', label: 'has VAT number', pack: 'core', domain: PARTY, range: { value: 'vatID' }, cardinality: 'single', temporality: 'immutable', matchKey: true, hint: 'an EU VAT number with its country prefix, e.g. ESB12345678' },
  { id: 'iban', label: 'has bank account', pack: 'core', domain: PARTY, range: { value: 'iban' }, cardinality: 'multi', temporality: 'interval', matchKey: true, hint: 'an IBAN the party receives payments on' },
  { id: 'worksFor', label: 'works for', pack: 'core', domain: ['Person'], range: { entity: ['Organization'] }, cardinality: 'multi', temporality: 'interval', hint: 'a person employed by or acting for an organisation' },
  { id: 'jobTitle', label: 'has job title', pack: 'core', domain: ['Person'], range: { value: 'text' }, cardinality: 'single', temporality: 'interval', hint: 'a role, e.g. "Finance manager"' },
  { id: 'memberOf', label: 'is a member of', pack: 'core', domain: PARTY, range: { entity: ['Organization'] }, cardinality: 'multi', temporality: 'interval', hint: 'membership of an association, board or group' },
  { id: 'parentOrganization', label: 'is part of', pack: 'core', domain: ['Organization'], range: { entity: ['Organization'] }, cardinality: 'single', temporality: 'interval', hint: 'the group or parent company of an organisation' },
  { id: 'location', label: 'is based in', pack: 'core', domain: PARTY, range: { entity: ['Place'] }, cardinality: 'multi', temporality: 'interval', hint: 'a city, building or site the party is at' },
  { id: 'mentions', label: 'mentions', pack: 'core', domain: ['Document'], range: { entity: ENTITY_TYPES }, cardinality: 'multi', temporality: 'point', hint: 'any person, organisation or place the document is about or names' },

  // invoice — schema.org Invoice, on the document itself
  { id: 'provider', label: 'was issued by', pack: 'invoice', domain: ['Document'], range: { entity: PARTY }, cardinality: 'single', temporality: 'immutable', hint: 'who issued the invoice, receipt or bill (the seller)' },
  { id: 'customer', label: 'is addressed to', pack: 'invoice', domain: ['Document'], range: { entity: PARTY }, cardinality: 'single', temporality: 'immutable', hint: 'who the invoice or bill is for (the buyer)' },
  { id: 'identifier', label: 'has number', pack: 'invoice', domain: ['Document'], range: { value: 'text' }, cardinality: 'single', temporality: 'immutable', hint: 'the invoice, receipt or reference number' },
  { id: 'totalPaymentDue', label: 'totals', pack: 'invoice', domain: ['Document'], range: { value: 'money' }, cardinality: 'single', temporality: 'immutable', hint: 'the total to pay, as "1234.56 EUR"' },
  { id: 'paymentDueDate', label: 'is due on', pack: 'invoice', domain: ['Document'], range: { value: 'date' }, cardinality: 'single', temporality: 'immutable', hint: 'when payment is due, as YYYY-MM-DD' },
  { id: 'dateIssued', label: 'is dated', pack: 'invoice', domain: ['Document'], range: { value: 'date' }, cardinality: 'single', temporality: 'immutable', hint: 'the date printed on the document, as YYYY-MM-DD' },

  // es — Spain
  { id: 'es:nif', label: 'has NIF', pack: 'es', domain: PARTY, range: { value: 'es:nif' }, cardinality: 'single', temporality: 'immutable', matchKey: true, hint: 'a Spanish NIF, NIE or CIF tax id, e.g. B12345678' },

  // se — Sweden
  { id: 'se:orgnr', label: 'has org. number', pack: 'se', domain: ['Organization'], range: { value: 'se:orgnr' }, cardinality: 'single', temporality: 'immutable', matchKey: true, hint: 'a Swedish organisationsnummer, e.g. 556677-8899' },
  { id: 'se:personnummer', label: 'has personnummer', pack: 'se', domain: ['Person'], range: { value: 'se:personnummer' }, cardinality: 'single', temporality: 'immutable', matchKey: true, sensitive: true, hint: 'a Swedish personal identity number' },
];

const BY_ID = new Map(PREDICATES.map((p) => [p.id, p]));
export const predicateById = (id: string): PredicateDef | undefined => BY_ID.get(id);
export const isEntityType = (value: unknown): value is EntityType => typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value);

/** A normalised value: what is stored and matched on, and what a list shows. */
export interface NormalValue { value: string; display: string }

const collapse = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Luhn over a digit string, as Swedish identity numbers use it. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 over an IBAN with its first four characters moved to the end. */
function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
/** DNI (8 digits + letter), NIE (X/Y/Z + 7 digits + letter) and CIF (letter + 7 digits + control). */
function nifValid(nif: string): boolean {
  const dni = /^(\d{8})([A-Z])$/.exec(nif);
  if (dni) return NIF_LETTERS[Number(dni[1]) % 23] === dni[2];
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(nif);
  if (nie) return NIF_LETTERS[Number(`${'XYZ'.indexOf(nie[1]!)}${nie[2]}`) % 23] === nie[3];
  const cif = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(nif);
  if (!cif) return false;
  const digits = cif[2]!;
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    let d = Number(digits[i]);
    if (i % 2 === 0) { d *= 2; d = Math.floor(d / 10) + (d % 10); }
    sum += d;
  }
  const control = (10 - (sum % 10)) % 10;
  return cif[3] === String(control) || cif[3] === 'JABCDEFGHI'[control];
}

const VAT_PREFIXES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI', 'GB', 'NO', 'CH']);

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The value in its one stored form, or null when it is not a value of that kind. A wrong
 * checksum is a misread, and a misread is dropped rather than suggested.
 */
export function normalizeValue(kind: ValueKind, raw: string): NormalValue | null {
  const text = collapse(String(raw ?? ''));
  if (!text) return null;
  switch (kind) {
    case 'text': {
      const value = [...text].slice(0, 300).join('');
      return { value, display: value };
    }
    case 'email': {
      const value = text.toLowerCase().replace(/^mailto:/, '');
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254 ? { value, display: value } : null;
    }
    case 'telephone': {
      let digits = text.replace(/[\s().\-/]/g, '');
      if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
      return /^\+?\d{6,15}$/.test(digits) ? { value: digits, display: text } : null;
    }
    case 'url': {
      // Only the web: a scheme other than http(s) is not a website. No `URL` here — this module
      // runs where neither the DOM's nor Node's globals are declared.
      if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) && !/^https?:\/\//i.test(text)) return null;
      const m = /^(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?(\/[^\s?#]*)?/i.exec(text);
      if (!m) return null;
      const value = `${m[1]!.toLowerCase().replace(/^www\./, '')}${(m[2] ?? '').replace(/\/+$/, '')}`;
      return { value, display: value };
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      return m && validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? { value: text, display: text } : null;
    }
    case 'money': {
      const m = /^(-?\d+(?:[.,]\d{1,2})?)\s*([A-Za-z]{3})$/.exec(text.replace(/[\s'](?=\d{3}\b)/g, ''));
      if (!m) return null;
      const amount = Number(m[1]!.replace(',', '.'));
      if (!Number.isFinite(amount)) return null;
      const value = `${amount.toFixed(2)} ${m[2]!.toUpperCase()}`;
      return { value, display: value };
    }
    case 'iban': {
      const value = text.replace(/[\s-]/g, '').toUpperCase();
      return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(value) && ibanValid(value)
        ? { value, display: value.replace(/(.{4})/g, '$1 ').trim() } : null;
    }
    case 'vatID': {
      const value = text.replace(/[\s.\-]/g, '').toUpperCase();
      return /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(value) && VAT_PREFIXES.has(value.slice(0, 2)) && /\d/.test(value.slice(2))
        ? { value, display: value } : null;
    }
    case 'es:nif': {
      const value = text.replace(/[\s.\-]/g, '').toUpperCase().replace(/^ES/, '');
      return nifValid(value) ? { value, display: value } : null;
    }
    case 'se:orgnr': {
      const compact = text.replace(/[\s-]/g, '').toUpperCase();
      // A Swedish VAT number is SE + the org. number + 01.
      const digits = /^SE\d{10}01$/.test(compact) ? compact.slice(2, 12) : compact;
      if (!/^\d{10}$/.test(digits) || Number(digits[2]) < 2 || !luhn(digits)) return null;
      const value = `${digits.slice(0, 6)}-${digits.slice(6)}`;
      return { value, display: value };
    }
    case 'se:personnummer': {
      const digits = text.replace(/[\s+-]/g, '');
      const ten = digits.length === 12 ? digits.slice(2) : digits;
      if (!/^\d{10}$/.test(ten) || !luhn(ten)) return null;
      const month = Number(ten.slice(2, 4)), day = Number(ten.slice(4, 6));
      // Day + 60 is a samordningsnummer; both identify a person.
      if (month < 1 || month > 12 || !((day >= 1 && day <= 31) || (day >= 61 && day <= 91))) return null;
      const value = `${ten.slice(0, 6)}-${ten.slice(6)}`;
      return { value, display: `${ten.slice(0, 6)}-****` };
    }
  }
}

const LEGAL_SUFFIXES = / (slu|sl|sau|sa|sc|scoop|sll|ab|hb|kb|ltd|limited|inc|incorporated|corp|corporation|llc|llp|plc|gmbh|ag|bv|nv|oy|oyj|as|asa|aps|a\/s|sas|sarl|srl|spa|co|company)$/;

/**
 * The name as identity resolution compares it: case, accents, punctuation and an
 * organisation's legal form ("Acme, S.L." = "ACME SL" = "Acme") do not tell two parties apart.
 */
export function nameKey(type: EntityType, name: string): string {
  let key = collapse(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  // Dots go without a trace, so "S.L." reads as "sl"; other punctuation separates words.
  key = key.replace(/\./g, '').replace(/[^\p{L}\p{N}\s/]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (type === 'Organization') {
    for (let i = 0; i < 2; i++) key = key.replace(LEGAL_SUFFIXES, '').trim();
  }
  return key;
}

/** Whether `predicate` can say something about a subject of this type. */
export const allowsSubject = (predicate: PredicateDef, subject: SubjectType) => predicate.domain.includes(subject);
/** Whether `predicate` can point at an entity of this type. */
export const allowsObjectEntity = (predicate: PredicateDef, type: EntityType) =>
  'entity' in predicate.range && predicate.range.entity.includes(type);
