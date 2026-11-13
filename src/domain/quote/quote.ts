export type QuoteStatus =
  | 'ISSUED'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELED';

export type QuoteCustomer = {
  id: string;
  name: string;
  document: string;
  email: string;
};

export type QuoteService = {
  serviceId: string;
  description: string;
  priceCents: number;
};

export type QuoteAutoPart = {
  autoPartId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
};

export type QuoteItems = {
  services: QuoteService[];
  autoParts: QuoteAutoPart[];
};

export type Quote = {
  id: string;
  serviceOrderId: string;
  customer: QuoteCustomer;
  status: QuoteStatus;
  items: QuoteItems;
  servicesTotalCents: number;
  autoPartsTotalCents: number;
  totalCents: number;
  currency: string;
  expiresAt: Date;
  createdAt: Date;
};

const HOUR_MS = 60 * 60 * 1000;

type IssueInput = {
  serviceOrderId: string;
  customer: QuoteCustomer;
  items: QuoteItems;
  currency: string;
  now: Date;
  validityHours: number;
};

export const issueQuote = ({
  serviceOrderId,
  customer,
  items,
  currency,
  now,
  validityHours,
}: IssueInput): Quote => {
  const servicesTotalCents = items.services.reduce(
    (sum, service) => sum + service.priceCents,
    0,
  );
  const autoPartsTotalCents = items.autoParts.reduce(
    (sum, part) => sum + part.quantity * part.unitPriceCents,
    0,
  );

  return {
    id: Bun.randomUUIDv7(),
    serviceOrderId,
    customer,
    status: 'ISSUED',
    items,
    servicesTotalCents,
    autoPartsTotalCents,
    totalCents: servicesTotalCents + autoPartsTotalCents,
    currency,
    expiresAt: new Date(now.getTime() + validityHours * HOUR_MS),
    createdAt: now,
  };
};

const normalizeDocument = (document: string): string =>
  document.replace(/[^0-9a-z]/gi, '').toLowerCase();

export const belongsToCustomer = (quote: Quote, document: string): boolean => {
  const given = normalizeDocument(document);

  return given !== '' && given === normalizeDocument(quote.customer.document);
};

export const effectiveStatus = (quote: Quote, now: Date): QuoteStatus =>
  quote.status === 'ISSUED' && now.getTime() > quote.expiresAt.getTime()
    ? 'EXPIRED'
    : quote.status;

export const DEFAULT_VALIDITY_HOURS = 72;

export const parseValidityHours = (raw: string | undefined): number => {
  const hours = Number(raw);

  return raw?.trim() && Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_VALIDITY_HOURS;
};
