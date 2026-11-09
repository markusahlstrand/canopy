import { z } from 'zod';
import type { FetchLike } from '@substrat-run/kernel';

export const QONTO_API_BASE = 'https://thirdparty.qonto.com';

/**
 * The credential from Qonto's Integrations and Partnerships > API key page. An API key reads every
 * endpoint this connector calls, so no OAuth application is needed.
 */
export const qontoSecret = z.object({
  login: z.string().trim().min(1).max(200),
  secretKey: z.string().trim().min(1).max(200),
});
export type QontoSecret = z.infer<typeof qontoSecret>;

/** Qonto answered, and not with success. `status` says whose problem it is. */
export class QontoError extends Error {
  constructor(readonly status: number, what: string, detail = '') {
    super(`Qonto answered ${status} to ${what}${detail ? `: ${detail}` : ''}`);
    this.name = 'QontoError';
  }
}

export interface QontoBankAccount { id: string; name?: string | null; iban?: string | null }
export interface QontoOrganization { slug: string; legal_name?: string | null; name?: string | null; bank_accounts: QontoBankAccount[] }

export interface QontoAttachment {
  id: string;
  file_name?: string | null;
  file_size?: string | number | null;
  file_content_type?: string | null;
  /** Pre-signed and good for 30 minutes: read it now, never keep it. */
  url: string;
}

export interface QontoTransaction {
  id: string;
  amount: number;
  currency: string;
  side: string;
  label?: string | null;
  clean_counterparty_name?: string | null;
  settled_at?: string | null;
  emitted_at: string;
  updated_at: string;
  attachment_ids?: (string | null)[] | null;
  attachments?: QontoAttachment[] | null;
  [field: string]: unknown;
}

export interface QontoSupplierInvoice { id: string; attachment_id: string; invoice_number?: string | null; supplier_name?: string | null; issue_date?: string | null; updated_at?: string | null }

interface ClientParty { name?: string | null; first_name?: string | null; last_name?: string | null }
export interface QontoClientInvoice { id: string; attachment_id?: string | null; number?: string | null; issue_date?: string | null; status?: string; client?: ClientParty | null }
export interface QontoCreditNote { id: string; attachment_id?: string | null; number?: string | null; issue_date?: string | null; created_at?: string | null; client?: ClientParty | null }

export interface QontoStatement {
  id: string;
  bank_account_id: string;
  /** `MM-YYYY`. */
  period: string;
  file: { file_name?: string | null; file_content_type?: string | null; file_size?: number | null; file_url: string };
}

export interface QontoClient {
  organization(): Promise<QontoOrganization>;
  transactions(input: { bankAccountId: string; updatedFrom?: string; page: number; perPage: number }): Promise<QontoTransaction[]>;
  supplierInvoices(input: { updatedFrom?: string; page: number; perPage: number }): Promise<QontoSupplierInvoice[]>;
  clientInvoices(input: { updatedFrom?: string; page: number; perPage: number }): Promise<QontoClientInvoice[]>;
  creditNotes(input: { createdFrom?: string; page: number; perPage: number }): Promise<QontoCreditNote[]>;
  statements(input: { page: number; perPage: number }): Promise<QontoStatement[]>;
  attachment(id: string): Promise<QontoAttachment>;
  /** A pre-signed file URL. The credential is never sent with it: this host is not Qonto's API. */
  download(url: string): Promise<Uint8Array>;
}

const query = (params: Record<string, string | number | undefined>) =>
  Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

export function createQontoClient(input: { secret: QontoSecret; fetch: FetchLike; apiBase?: string }): QontoClient {
  const base = (input.apiBase ?? QONTO_API_BASE).replace(/\/+$/, '');
  // Qonto's key format resembles Basic auth but is not base64-encoded.
  const authorization = `${input.secret.login}:${input.secret.secretKey}`;

  const get = async <T>(path: string, what: string): Promise<T> => {
    const res = await input.fetch(`${base}${path}`, { method: 'GET', headers: { authorization, accept: 'application/json' } });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new QontoError(res.status, what, text.slice(0, 200));
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new QontoError(res.status, what, 'the answer was not JSON');
    }
  };

  return {
    organization: async () => (await get<{ organization: QontoOrganization }>('/v2/organization', 'the organization request')).organization,
    transactions: async ({ bankAccountId, updatedFrom, page, perPage }) => (await get<{ transactions: QontoTransaction[] }>(
      `/v2/transactions?${query({ bank_account_id: bankAccountId, 'includes[]': 'attachments', sort_by: 'updated_at:asc', updated_at_from: updatedFrom, page, per_page: perPage })}`,
      'the transactions list',
    )).transactions,
    supplierInvoices: async ({ updatedFrom, page, perPage }) => (await get<{ supplier_invoices: QontoSupplierInvoice[] }>(
      `/v2/supplier_invoices?${query({ 'filter[updated_at_from]': updatedFrom, page, per_page: perPage })}`,
      'the supplier invoices list',
    )).supplier_invoices,
    clientInvoices: async ({ updatedFrom, page, perPage }) => (await get<{ client_invoices: QontoClientInvoice[] }>(
      // Drafts are not documents yet; an imported invoice is one the account holds all the same.
      `/v2/client_invoices?${query({ 'filter[status]': 'unpaid,paid,canceled', 'filter[updated_at_from]': updatedFrom, exclude_imported: 'false', page, per_page: perPage })}`,
      'the client invoices list',
    )).client_invoices,
    creditNotes: async ({ createdFrom, page, perPage }) => (await get<{ credit_notes: QontoCreditNote[] }>(
      `/v2/credit_notes?${query({ 'filter[created_at_from]': createdFrom, page, per_page: perPage })}`,
      'the credit notes list',
    )).credit_notes,
    statements: async ({ page, perPage }) => (await get<{ statements: QontoStatement[] }>(
      `/v2/statements?${query({ page, per_page: perPage })}`,
      'the statements list',
    )).statements,
    attachment: async (id) => (await get<{ attachment: QontoAttachment }>(`/v2/attachments/${encodeURIComponent(id)}`, 'an attachment request')).attachment,
    download: async (url) => {
      const res = await input.fetch(url, { method: 'GET' });
      if (res.status < 200 || res.status >= 300) throw new QontoError(res.status, 'a file download');
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
