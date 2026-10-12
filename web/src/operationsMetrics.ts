export function metricValue(metric: { value?: number; state: string; unit: string }) {
  if (metric.state !== 'available' || metric.value === undefined || !Number.isFinite(metric.value) || metric.value < 0)
    return metric.state === 'unavailable' ? 'Unavailable' : 'Unknown';
  return `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${metric.unit ? ' ' + metric.unit : ''}`;
}
