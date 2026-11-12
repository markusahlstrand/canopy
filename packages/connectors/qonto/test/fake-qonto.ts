import type { QontoAttachment, QontoClientInvoice, QontoCreditNote, QontoStatement, QontoSupplierInvoice, QontoTransaction } from '../src/client.js';

export const API = 'https://qonto.test', FILES = 'https://files.test';
export const LOGIN = 'acme-1234', KEY = 'secret-key';

/**
 * An id as Qonto mints them: a time-ordered UUID, so ids made close together share their head,
 * and only the tail tells them apart. Every fake id shares one head on purpose.
 */
export const qontoId = (n: number, head = '019fbabc') => `${head}-1c2d-7e3f-8a4b-${n.toString(16).padStart(12, '0')}`;

/** Qonto's API as far as the connector reads it. */
export class FakeQonto {
  accounts = [{ id: 'bank-1', name: 'Main' }];
  transactions: QontoTransaction[] = [];
  supplier: QontoSupplierInvoice[] = [];
  client: QontoClientInvoice[] = [];
  credit: QontoCreditNote[] = [];
  statements: QontoStatement[] = [];
  attachments = new Map<string, QontoAttachment>();
  calls: { url: string; authorization: string | undefined }[] = [];
  status: Record<string, number> = {};
  private seq = 0;

  file(name = 'receipt.pdf', type = 'application/pdf', id = qontoId(++this.seq)): QontoAttachment {
    const a = { id, file_name: name, file_size: '7', file_content_type: type, url: `${FILES}/${id}` };
    this.attachments.set(id, a);
    return a;
  }
  tx(partial: Partial<QontoTransaction> = {}): QontoTransaction {
    const n = ++this.seq;
    const t: QontoTransaction = { id: qontoId(n), amount: 59.99, currency: 'EUR', side: 'debit', clean_counterparty_name: 'Adobe', settled_at: '2026-11-03T10:00:00.000Z', emitted_at: '2026-11-03T09:00:00.000Z', updated_at: `2026-11-03T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`, attachment_ids: [], attachments: [], logo: { small: 'x', medium: 'y' }, ...partial };
    this.transactions.push(t);
    return t;
  }

  fetch = async (input: unknown, init?: { headers?: Record<string, string> }): Promise<Response> => {
    const url = new URL(String(input));
    this.calls.push({ url: String(input), authorization: init?.headers?.authorization });
    if (url.origin === FILES) return new Response('%PDF-1\n');
    const key = url.pathname;
    if (this.status[key]) return new Response('nope', { status: this.status[key] });
    if (init?.headers?.authorization !== `${LOGIN}:${KEY}`) return new Response('unauthorized', { status: 401 });
    const page = Number(url.searchParams.get('page') ?? 1), perPage = Number(url.searchParams.get('per_page') ?? 100);
    const slice = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);
    if (key === '/v2/organization') return Response.json({ organization: { slug: 'acme', legal_name: 'Acme SL', bank_accounts: this.accounts } });
    if (key === '/v2/transactions') {
      const from = url.searchParams.get('updated_at_from');
      const rows = this.transactions.filter((t) => !from || t.updated_at >= from).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return Response.json({ transactions: slice(rows) });
    }
    if (key === '/v2/supplier_invoices') return Response.json({ supplier_invoices: slice(this.supplier) });
    if (key === '/v2/client_invoices') return Response.json({ client_invoices: slice(this.client) });
    if (key === '/v2/credit_notes') return Response.json({ credit_notes: slice(this.credit) });
    if (key === '/v2/statements') return Response.json({ statements: slice(this.statements) });
    const attachment = /^\/v2\/attachments\/(.+)$/.exec(key);
    if (attachment) return Response.json({ attachment: this.attachments.get(attachment[1]!) });
    return new Response('not found', { status: 404 });
  };
}
