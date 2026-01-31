export type PlanTier = 'estandar' | 'alta' | 'maxima';

const normalizePlanKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

export const resolvePlanTier = (plan: unknown): PlanTier => {
  const normalized = normalizePlanKey(plan);
  if (!normalized) return 'estandar';
  if (normalized.includes('maxima') || normalized.includes('pro')) return 'maxima';
  if (normalized.includes('alta') || normalized.includes('premium')) return 'alta';
  return 'estandar';
};

export const resolvePlanCode = (plan: unknown) => {
  const normalized = normalizePlanKey(plan);
  if (!normalized) return null;
  if (normalized.includes('maxima') || normalized.includes('pro')) return 'PRO';
  if (normalized.includes('alta') || normalized.includes('premium')) return 'ALTA';
  if (normalized.includes('estandar') || normalized.includes('basic') || normalized.includes('standard')) {
    return 'ESTANDAR';
  }
  return null;
};

export const getPlanRank = (tier: PlanTier) => {
  if (tier === 'alta') return 1;
  if (tier === 'maxima') return 2;
  return 0;
};

export const isUpgradeAllowed = (currentPlan: unknown, targetPlan: unknown) => {
  const currentTier = resolvePlanTier(currentPlan);
  const targetTier = resolvePlanTier(targetPlan);
  return getPlanRank(targetTier) > getPlanRank(currentTier);
};

