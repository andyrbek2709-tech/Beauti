type CounterName =
  | "http_requests_total"
  | "http_errors_total"
  | "book_success_total"
  | "book_conflict_total"
  | "cancel_success_total"
  | "telegram_webhook_total"
  | "telegram_webhook_duplicate_total";

const counters = new Map<CounterName, number>();

function incCounter(name: CounterName, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export const metrics = {
  incCounter,
  snapshotCounters
};
