import type { Tone } from '@/components/ui';

/** One place that maps service statuses to badge tones, so colours mean the same thing everywhere. */

export function gatewayStatusTone(status: string): Tone {
  if (status === 'success') return 'ok';
  if (status === 'partial') return 'warn';
  if (status === 'aborted') return 'neutral';
  return 'danger';
}

export function reviewStatusTone(status: string): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'info';
    case 'failed':
      return 'danger';
    case 'insufficient_balance':
    case 'quota_exceeded':
    case 'not_linked':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function severityTone(sev: string): Tone {
  switch (sev) {
    case 'critical':
      return 'danger';
    case 'high':
      return 'orange';
    case 'medium':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function agentStatusTone(status: string): Tone {
  switch (status) {
    case 'running':
      return 'ok';
    case 'deploying':
      return 'info';
    case 'error':
      return 'danger';
    case 'suspended_billing':
    case 'paused_budget':
      return 'warn';
    default:
      return 'neutral';
  }
}

/**
 * Scam-check levels. Low / "safe" are deliberately *not* green: "no scam signs
 * found yet" is not a guarantee, so it gets the calm informational tone.
 */
export function riskTone(level: string): Tone {
  switch (level) {
    case 'critical':
      return 'danger';
    case 'high':
      return 'orange';
    case 'medium':
      return 'warn';
    case 'low':
    case 'safe':
      return 'info';
    default:
      return 'neutral';
  }
}
