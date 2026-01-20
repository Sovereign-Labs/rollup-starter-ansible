import type { Check } from './types.js';
import { waitDeploymentCheck } from './wait-deployment.js';

const allChecks: Check[] = [
  waitDeploymentCheck,
];

export function getAllChecks(): Check[] {
  return allChecks;
}

export function getNonDestructiveChecks(): Check[] {
  return allChecks.filter(c => !c.destructive);
}

export function getDestructiveChecks(): Check[] {
  return allChecks.filter(c => c.destructive);
}

export type { Check, CheckResult, CheckContext } from './types.js';
