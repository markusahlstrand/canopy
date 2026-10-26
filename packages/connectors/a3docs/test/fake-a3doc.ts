import type { FetchLike } from '@substrat-run/kernel';
import { bytesToBase64, type A3Container } from '../src/client.js';

/**
 * A stand-in for a3doc's WebAPI and its address provider, shaped like the real ones: every call is
 * a JSON POST carrying `token`, every answer is HTTP 200 with an `errorCode`, the root container
 * ignores `searchChildContainers: false`, and listings come newest-modified first. All ids, names
 * and customers are made up.
 */

export const ADDRESS = 'https://addr.a3.example';
export const API = 'https://a3.example/WebAPI/v1';
export const COMPANY = 'C0001';
export const USER = 'cliente';
export const PASSWORD = 'secret-pass';
export const CUSTOMER = 'B00000000';

interface FakeDoc {
  Id: string;
  Code: number;
  Title: string;
  Type: string;
  bytes: Uint8Array;
  /** Override for the listed size in KB (to fake a file over the cap without holding it). */
  sizeKb?: number;
  DateModified: string;
  CustomerId: string;
  ContainersId: number[];
}

export class FakeA3doc {
  role = 5;
  private token: string | null = null;
  private code = 1000;
  private clock = Date.UTC(2026, 9, 1, 8, 0, 0);
  readonly docs: FakeDoc[] = [];
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  /** Requests whose work is done but whose answer is lost (the fetch rejects), once each. */
  readonly lostAnswers: ((method: string) => boolean)[] = [];
  tree: A3Container[] = [
    {
      id: 1,
      name: 'Todos',
      children: [
        { id: 10, name: 'Fiscal', children: [{ id: 11, name: 'Modelo 303', children: null }] },
        { id: 20, name: 'Facturas', children: [{ id: 21, name: 'Recibidas', children: null }] },
      ],
    },
  ];

  /** A Madrid wall-clock `DD/MM/YYYY HH:MM:SS`, a minute later each call. */
  tick(): string {
    this.clock += 60_000;
    const d = new Date(this.clock);
    const p = (n: number) => String(n).padStart(2, '0');
    // Madrid is UTC+2 in early October; the exact offset does not matter to the fake, only order.
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours() + 2)}:${p(d.getUTCMinutes())}:00`;
  }

  add(containers: number[], title: string, body: string | Uint8Array, opts: { type?: string; modified?: string; sizeKb?: number } = {}): FakeDoc {
    const doc: FakeDoc = {
      Id: `doc-${crypto.randomUUID()}`,
      Code: ++this.code,
      Title: title,
      Type: opts.type ?? '.PDF',
      bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      ...(opts.sizeKb !== undefined ? { sizeKb: opts.sizeKb } : {}),
      DateModified: opts.modified ?? this.tick(),
      CustomerId: CUSTOMER,
      ContainersId: containers,
    };
    this.docs.push(doc);
    return doc;
  }

  edit(doc: FakeDoc, patch: Partial<Pick<FakeDoc, 'Title' | 'ContainersId' | 'bytes' | 'DateModified'>>, opts: { touch?: boolean } = {}) {
    Object.assign(doc, patch);
    if (opts.touch !== false && !patch.DateModified) doc.DateModified = this.tick();
  }

  remove(doc: FakeDoc) {
    this.docs.splice(this.docs.indexOf(doc), 1);
  }

  titlesIn(container: number): string[] {
    return this.docs.filter((d) => d.ContainersId.includes(container)).map((d) => `${d.Title}${d.Type.toLowerCase()}`).sort();
  }

  private descendants(id: number): number[] {
    const out: number[] = [];
    const walk = (nodes: A3Container[] | null | undefined, inside: boolean) => {
      for (const n of nodes ?? []) {
        if (inside) out.push(n.id);
        walk(n.children, inside || n.id === id);
      }
    };
    walk(this.tree, false);
    return out;
  }

  private sortKey(d: FakeDoc): string {
    const [date, time] = d.DateModified.split(' ');
    const [dd, mm, yyyy] = date!.split('/');
    return `${yyyy}${mm}${dd}${time}`;
  }

  private handle(method: string, body: Record<string, unknown>): unknown {
    if (method === 'signIn') {
      if (body.tenant !== COMPANY || body.user !== USER || body.password !== PASSWORD) {
        return { errorCode: 1, errorMessage: 'Usuario o contraseña incorrectos.' };
      }
      this.token = `tok-${this.calls.length}`;
      return { errorCode: 0, token: this.token };
    }
    if (!this.token || body.token !== this.token) return { errorCode: 6, errorMessage: 'El token de seguridad no es válido.' };
    switch (method) {
      case 'UserInfo':
        return { errorCode: 0, completeUserName: 'Cliente Prueba', mailAddress: 'cliente@example.com', userType: '1', userRol: String(this.role) };
      case 'ContainersTree':
        return { errorCode: 0, tree: this.tree };
      case 'GetDocumentsExtended': {
        const cid = (body.containersIdsToSearch as number[])[0]!;
        const scope = cid === 1 || body.searchChildContainers ? [cid, ...this.descendants(cid)] : [cid];
        const title = (body.filter as { AttributeId: number; FilterValue: string }[]).find((f) => f.AttributeId === 3)?.FilterValue;
        const matching = this.docs
          .filter((d) => cid === 1 || d.ContainersId.some((c) => scope.includes(c)))
          .filter((d) => title === undefined || d.Title === title)
          .sort((a, b) => this.sortKey(b).localeCompare(this.sortKey(a)));
        const size = body.pageSize as number;
        const start = (body.pageIndex as number) * size;
        return {
          errorCode: 0,
          countAllDocuments: matching.length,
          documents: matching.slice(start, start + size).map(({ bytes, sizeKb, ...d }) => ({ ...d, Size: sizeKb ?? Math.floor(bytes.byteLength / 1024) })),
        };
      }
      case 'Download': {
        const doc = this.docs.find((d) => d.Id === body.documentId);
        if (!doc) return { errorCode: 2, errorMessage: 'No existe el documento.' };
        return { errorCode: 0, length: doc.bytes.byteLength, content: bytesToBase64(doc.bytes) };
      }
      case 'Upload': {
        const doc = this.add(body.containersIds as number[], body.title as string, Uint8Array.from(atob(body.content as string), (c) => c.charCodeAt(0)), {
          type: (body.extension as string).toUpperCase(),
        });
        doc.CustomerId = body.customerId as string;
        return { errorCode: 0, documentId: doc.Id };
      }
      default:
        return { errorCode: 3, errorMessage: 'Error en los parámetros indicados en la llamada.' };
    }
  }

  readonly fetch = (async (url: string, init?: { body?: unknown }) => {
    if (url.startsWith(`${ADDRESS}/v1/Address/`)) {
      const code = decodeURIComponent(url.split('/').pop()!);
      return new Response(JSON.stringify(code === COMPANY ? { URL: API.replace(/\/v1$/, '') } : { errorCode: 1, errorMessage: 'Empresa no encontrada' }));
    }
    const method = url.slice(API.length + 1);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, body });
    const answer = this.handle(method, body);
    const lost = this.lostAnswers.findIndex((when) => when(method));
    if (lost >= 0) {
      this.lostAnswers.splice(lost, 1);
      throw new Error('connection reset: the answer was lost');
    }
    return new Response(JSON.stringify(answer));
  }) as unknown as FetchLike;
}
