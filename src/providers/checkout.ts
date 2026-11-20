// Checkout provider seam (KITE-AND-PROVIDERS.md): explicit capabilities, and
// automatic paid execution stays disabled until a configured provider with
// owner authority exists. The emulator is a team-controlled, labeled
// non-settling test double — its receipts are NOT real settlement evidence.

export interface CheckoutRequest {
  order_id: string;
  amount_atomic: number;
  asset_symbol: string;
  rail: string;
  idempotency_key: string;
  description: string;
}

export type SettlementStatus = 'settled' | 'pending' | 'unknown' | 'failed';

export interface CheckoutResult {
  payment_ref: string;
  status: SettlementStatus;
  provider: string;
}

export interface ProviderCapabilities {
  quote: boolean; execute: boolean; status: boolean; refund: boolean;
}

export interface CheckoutProvider {
  id: string;
  kind: 'emulator' | 'external';
  capabilities(): ProviderCapabilities;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  inspect(paymentRef: string): Promise<{ status: SettlementStatus; settled_at?: string }>;
}

export class ProviderUnavailable extends Error {
  readonly provider: string;
  constructor(provider: string, msg: string) {
    super(msg);
    this.provider = provider;
  }
}

interface EmulatedPayment {
  ref: string; order_id: string; amount_atomic: number;
  status: SettlementStatus; created_at: string;
}

// Deterministic in-process checkout: settles immediately, or can be forced
// into pending/unknown for fault injection. Labeled so records can never be
// confused with a live payment rail.
export class LocalCheckoutEmulator implements CheckoutProvider {
  readonly id = 'local-emulator';
  readonly kind = 'emulator' as const;
  private payments = new Map<string, EmulatedPayment>();
  private seq = 0;
  /** Fault injection: what createCheckout reports on the first call. */
  firstCallStatus: SettlementStatus = 'settled';
  /** Fault injection: what inspect reports until set directly. */
  inspectStatus: SettlementStatus | null = null;
  private createdAt = new Map<string, string>();

  capabilities(): ProviderCapabilities {
    return { quote: true, execute: true, status: true, refund: false };
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const ref = `pay_emu_${(++this.seq).toString(36)}_${req.order_id.slice(-6)}`;
    const status = this.firstCallStatus;
    const ts = new Date().toISOString();
    this.payments.set(ref, {
      ref, order_id: req.order_id, amount_atomic: req.amount_atomic,
      status: status === 'unknown' ? 'unknown' : status, created_at: ts,
    });
    this.createdAt.set(ref, ts);
    return { payment_ref: ref, status, provider: this.id };
  }

  async inspect(paymentRef: string) {
    const p = this.payments.get(paymentRef);
    if (!p) return { status: 'unknown' as SettlementStatus };
    return { status: this.inspectStatus ?? p.status, settled_at: p.status === 'settled' ? p.created_at : undefined };
  }

  // Test/operator controls (not part of the provider contract).
  forceSettle(ref: string) {
    const p = this.payments.get(ref);
    if (p) p.status = 'settled';
  }
}

// Honest placeholder for the supported external checkout. Fails closed: no
// payment reference is invented, and the order surfaces provider_unavailable.
export class DisabledExternalCheckout implements CheckoutProvider {
  readonly id: string;
  readonly kind = 'external' as const;
  constructor(id = 'kite-passport') { this.id = id; }
  capabilities(): ProviderCapabilities {
    return { quote: false, execute: false, status: false, refund: false };
  }
  createCheckout(): Promise<CheckoutResult> {
    return Promise.reject(new ProviderUnavailable(this.id,
      `provider "${this.id}" is not configured in this environment; automatic paid execution is disabled (see docs/build-pack/KITE-AND-PROVIDERS.md)`));
  }
  inspect(): Promise<{ status: SettlementStatus }> {
    return Promise.reject(new ProviderUnavailable(this.id, `provider "${this.id}" is not configured`));
  }
}
