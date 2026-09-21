import { describe, expect, it } from 'bun:test';
import { createHttpMetrics, getMetrics, normalizeRoute } from './metrics';

describe('normalizeRoute', () => {
  it('keeps a static path as it is', () => {
    expect(normalizeRoute('/health')).toBe('/health');
  });

  it('falls back to the root for an empty path', () => {
    expect(normalizeRoute('')).toBe('/');
  });
});

describe('createHttpMetrics', () => {
  it('records a finished request under its method and status', async () => {
    const metrics = createHttpMetrics();
    const request = new Request('http://localhost/health');

    metrics.start(request);
    metrics.finish(request, 200);

    const exposed = await getMetrics();

    expect(exposed).toContain('http_requests_total');
    expect(exposed).toContain('status_code="200"');
  });

  it('defaults to 200 when the status is not a usable number', async () => {
    const metrics = createHttpMetrics();
    const request = new Request('http://localhost/ready');

    metrics.start(request);
    metrics.finish(request, undefined);

    expect(await getMetrics()).toContain('route="/ready"');
  });

  it('records a request that was never started', async () => {
    const metrics = createHttpMetrics();
    const request = new Request('http://localhost/metrics-less');

    metrics.finish(request, 500);

    expect(await getMetrics()).toContain('status_code="500"');
  });
});

describe('normalizeRoute com identificadores', () => {
  it('colapsa um uuid no caminho para :id', () => {
    expect(
      normalizeRoute('/service-orders/0193f2a1-4c7e-7000-8000-000000000001'),
    ).toBe('/service-orders/:id');
  });

  it('colapsa todos os uuids de um caminho aninhado', () => {
    const path =
      '/service-orders/0193f2a1-4c7e-7000-8000-000000000001' +
      '/items/0193f2a1-4c7e-7000-8000-000000000002';

    expect(normalizeRoute(path)).toBe('/service-orders/:id/items/:id');
  });
});
