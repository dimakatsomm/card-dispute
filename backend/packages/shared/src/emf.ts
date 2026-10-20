export type MetricLog = { readonly info: (obj: object, msg?: string) => void };

export type Metric = {
  readonly namespace: string;
  readonly name: string;
  readonly timestamp: number;
  readonly value?: number;
  readonly unit?: 'Count' | 'Milliseconds';
  // Low-cardinality labels only (e.g. eventType); never ids, emails or file names.
  readonly dimensions?: Readonly<Record<string, string>>;
};

// CloudWatch embedded metric format: the log line itself becomes the metric (docs/01).
export const emitMetric = (log: MetricLog, metric: Metric): void => {
  const dimensions = metric.dimensions ?? {};
  log.info(
    {
      ...dimensions,
      [metric.name]: metric.value ?? 1,
      _aws: {
        Timestamp: metric.timestamp,
        CloudWatchMetrics: [
          {
            Namespace: metric.namespace,
            Dimensions: [Object.keys(dimensions)],
            Metrics: [{ Name: metric.name, Unit: metric.unit ?? 'Count' }],
          },
        ],
      },
    },
    metric.name,
  );
};
