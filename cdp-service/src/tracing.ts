/**
 * OpenTelemetry Distributed Tracing
 * Provides end-to-end request tracing for CDP service
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { trace, context, Span, SpanStatusCode, Tracer } from '@opentelemetry/api';
import type { ServiceConfig, EvaluateRequest, IsolationLevel } from './types.js';
import { getLogger } from './logger.js';

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;

/**
 * Initialize OpenTelemetry tracing
 */
export function initTracing(config: ServiceConfig): void {
  const logger = getLogger();

  try {
    // Create resource with service information
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'openclaw-cdp-service',
      [ATTR_SERVICE_VERSION]: '1.0.0',
    });

    // Configure exporters (optional - only if endpoints are configured)
    const spanProcessors = [];

    if (config.monitoring?.zipkinEndpoint) {
      const zipkinExporter = new ZipkinExporter({
        url: config.monitoring.zipkinEndpoint,
      });
      spanProcessors.push(new BatchSpanProcessor(zipkinExporter));
      logger.info('Zipkin tracing enabled', { endpoint: config.monitoring.zipkinEndpoint });
    }

    // Initialize SDK
    sdk = new NodeSDK({
      resource,
      spanProcessors,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable instrumentations we don't need
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    tracer = trace.getTracer('openclaw-cdp-service');

    logger.info('OpenTelemetry tracing initialized');
  } catch (error) {
    logger.error('Failed to initialize tracing', error);
  }
}

/**
 * Shutdown tracing gracefully
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    tracer = null;
  }
}

/**
 * Get tracer instance
 */
export function getTracer(): Tracer {
  if (!tracer) {
    // Return no-op tracer if not initialized
    return trace.getTracer('noop');
  }
  return tracer;
}

/**
 * Create a span for evaluate operation
 */
export function startEvaluateSpan(
  request: EvaluateRequest
): { span: Span; endSpan: (error?: Error) => void } {
  const currentTracer = getTracer();

  const span = currentTracer.startSpan('cdp.evaluate', {
    attributes: {
      'cdp.agent_id': request.agentId || 'default',
      'cdp.target_id': request.targetId || 'unknown',
      'cdp.expression_length': request.expression.length,
      'cdp.await_promise': request.awaitPromise || false,
      'cdp.timeout_ms': request.budget?.timeoutMs || 0,
    },
  });

  const endSpan = (error?: Error) => {
    if (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  };

  return { span, endSpan };
}

/**
 * Add span attributes for isolation level
 */
export function addIsolationAttributes(span: Span, isolationLevel: IsolationLevel, engineId: string): void {
  span.setAttributes({
    'cdp.isolation_level': isolationLevel,
    'cdp.engine_id': engineId,
  });
}

/**
 * Add span attributes for CDP connection
 */
export function addConnectionAttributes(span: Span, wsUrl: string): void {
  span.setAttribute('cdp.websocket_url', wsUrl);
}

/**
 * Add span attributes for result
 */
export function addResultAttributes(span: Span, durationMs: number, resultSize: number): void {
  span.setAttributes({
    'cdp.duration_ms': durationMs,
    'cdp.result_size': resultSize,
  });
}

/**
 * Create a child span
 */
export function startChildSpan(
  parentSpan: Span,
  name: string,
  attributes?: Record<string, string | number | boolean>
): { span: Span; endSpan: (error?: Error) => void } {
  const currentTracer = getTracer();

  // Create context with parent span
  const ctx = trace.setSpan(context.active(), parentSpan);

  const span = currentTracer.startSpan(name, { attributes }, ctx);

  const endSpan = (error?: Error) => {
    if (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  };

  return { span, endSpan };
}

/**
 * Execute a function within a span context
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const currentTracer = getTracer();
  const span = currentTracer.startSpan(name, { attributes });

  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Get current span from context
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/**
 * Get trace ID from current context
 */
export function getCurrentTraceId(): string | undefined {
  const span = getCurrentSpan();
  if (!span) return undefined;

  const spanContext = span.spanContext();
  return spanContext.traceId;
}
